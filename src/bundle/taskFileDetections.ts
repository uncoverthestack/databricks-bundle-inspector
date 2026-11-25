import fs from "node:fs/promises";
import path from "node:path";
import { notebookViews, type CodeLanguage, type NotebookViews } from "./code/notebookViews.js";
import {
  literalValue,
  readArguments,
  tokenizePython,
  type PythonArgument,
  type PythonToken,
} from "./code/pythonTokenizer.js";
import { legacyReferencesInString, tokenizeSql, type SqlToken } from "./code/sqlTokenizer.js";
import { checkRunTarget, unquote } from "./runTargets.js";
import type { NotebookHeaderRule } from "./notebookFiles.js";
import { emptyRecord, hasOwnKey, own } from "./ownKeys.js";

/**
 * A single detected use of a Databricks secret-access call within a file.
 * Covers `dbutils.secrets.get`, `getBytes` and `list` in Python/Jupyter notebook/Source format notebooks and `secret()`/`try_secret()`
 * in Databricks SQL.
 */
export interface SecretDetection {
  /** 1-based line number where the call starts. */
  line: number;
  /** The source line on which the call appears. */
  raw: string;
  /**
   * The literal scope string when it can be determined statically, or `null`
   * when the scope is a variable whose value is only known at runtime.
   */
  scope: string | null;
  /**
   * The literal key string when it can be determined statically, or `null`
   * when the key is a variable whose value is only known at runtime.
   */
  key: string | null;
  /**
   * When `scope` is `null` and the scope comes from a notebook parameter: that parameter's
   * name. Set for `dbutils.widgets.get("x")` as the scope itself, or for a name assigned
   * from one exactly once in the file (issue 535).
   */
  scopeParameter?: string;
  /**
   * Optional human-readable note for contextual information surfaced to the
   * user — for example, a warning that the detected function is a preview
   * feature. Absent when there is nothing extra to communicate.
   */
  note?: string;
}

/** Returns the 1-based line number of `charIndex` within `content`. */
function getStartLine(content: string, charIndex: number): number {
  return content.slice(0, charIndex).split("\n").length;
}

/** Returns the source line that contains `charIndex`, with `\r` stripped. */
function getLineText(content: string, charIndex: number): string {
  const lineStart = content.lastIndexOf("\n", charIndex - 1) + 1;
  const lineEnd = content.indexOf("\n", charIndex);
  const raw = content.slice(
    lineStart,
    lineEnd === -1 ? content.length : lineEnd,
  );
  return raw.replace(/\r$/, "");
}

/** The argument called `keyword`, or else the positional argument at `position`. */
function argument(
  args: PythonArgument[],
  keyword: string,
  position: number,
): PythonArgument | undefined {
  return (
    args.find((arg) => arg.keyword === keyword) ??
    args.filter((arg) => arg.keyword === undefined)[position]
  );
}

/**
 * The names `dbutils` goes by in a file: `dbutils` itself, and variables assigned
 * from it, such as `dbu = dbutils`, `dbu = DBUtils(spark)`, `dbu = get_dbutils(spark)`,
 * `dbutils = w.dbutils` (Databricks SDK) or `from databricks.sdk.runtime import dbutils as dbu`.
 * Also variables holding one of its modules, such as `w = dbutils.widgets`, and
 * Databricks SDK clients (`w = WorkspaceClient()`), whose `secrets` API reads secrets.
 */
interface DbutilsNames {
  dbutils: Set<string>;
  /** Variables holding a Databricks SDK `WorkspaceClient`. */
  workspaceClients: Set<string>;
  /** Names the `WorkspaceClient` class is imported as. */
  clientClasses: Set<string>;
  /** Calls that return dbutils: `DBUtils(spark)`, `get_dbutils(spark)`, and import aliases of them. */
  factories: Set<string>;
  /** Variable name to the dbutils module it holds (`widgets`, `secrets`, ...). */
  modules: Map<string, string>;
  /** Offsets of `dbutils.<module>` that only feed such an assignment. */
  assignedModuleOffsets: Set<number>;
}

// `DBUtils` is the class in `pyspark.dbutils`; `get_dbutils` is not an API but the
// helper name Databricks examples use to build one, so it is matched by convention.
const DBUTILS_FACTORIES = ["DBUtils", "get_dbutils"];

function isOp(token: PythonToken | undefined, value: string): boolean {
  return token?.kind === "op" && token.value === value;
}

/**
 * The index just past a primary expression starting at `start`: names joined by `.`,
 * with call brackets, such as `w.dbutils` or `WorkspaceClient().dbutils`.
 */
function primaryExpressionEnd(tokens: PythonToken[], start: number): number {
  let i = start;
  while (i < tokens.length) {
    if (tokens[i]?.kind !== "name") return i;
    i += 1;
    while (isOp(tokens[i], "(")) {
      const call = readArguments(tokens, i);
      if (!call) return i;
      i = call.close + 1;
    }
    if (!isOp(tokens[i], ".")) return i;
    i += 1;
  }
  return i;
}

function dbutilsNames(tokens: PythonToken[]): DbutilsNames {
  const names: DbutilsNames = {
    dbutils: new Set(["dbutils"]),
    workspaceClients: new Set(),
    clientClasses: new Set(["WorkspaceClient"]),
    factories: new Set(DBUTILS_FACTORIES),
    modules: new Map(),
    assignedModuleOffsets: new Set(),
  };
  const factories = names.factories;
  const clientClasses = names.clientClasses;
  // Imports under another name: `import ... dbutils as dbu`, `DBUtils as DBU`, `WorkspaceClient as WC`.
  tokens.forEach((token, i) => {
    const alias = tokens[i + 2];
    if (token.kind !== "name" || tokens[i + 1]?.value !== "as" || alias?.kind !== "name") return;
    if (token.value === "dbutils") names.dbutils.add(alias.value);
    if (token.value === "DBUtils") factories.add(alias.value);
    if (token.value === "WorkspaceClient") clientClasses.add(alias.value);
  });
  // Twice, so an alias of an alias (`a = dbutils`, `b = a`) is found too.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < tokens.length; i++) {
      const target = tokens[i]!;
      const previous = tokens[i - 1];
      // `name = ...` as a statement, not `f(name=...)`, `a.name = ...` or `name == ...`.
      if (target.kind !== "name" || !isOp(tokens[i + 1], "=") || isOp(tokens[i + 2], "=")) continue;
      if (previous && previous.kind === "op" && "(,.=".includes(previous.value)) continue;
      const value = tokens[i + 2];
      const after = tokens[i + 3];
      if (value?.kind !== "name") continue;
      const chainEnd = primaryExpressionEnd(tokens, i + 2);
      const last = tokens[chainEnd - 1];
      const clientCall = isOp(after, "(") ? readArguments(tokens, i + 3) : undefined;
      if (clientClasses.has(value.value) && clientCall && chainEnd === clientCall.close + 1) {
        names.workspaceClients.add(target.value);
      } else if (chainEnd > i + 3 && last?.kind === "name" && last.value === "dbutils") {
        // `dbutils = w.dbutils` or `dbu = WorkspaceClient().dbutils`
        names.dbutils.add(target.value);
      } else if (names.dbutils.has(value.value) && !isOp(after, ".") && !isOp(after, "(")) {
        names.dbutils.add(target.value);
      } else if (factories.has(value.value) && isOp(after, "(")) {
        names.dbutils.add(target.value);
      } else if (names.dbutils.has(value.value) && isOp(after, ".")) {
        const module = tokens[i + 4];
        const end = tokens[i + 5];
        if (module?.kind === "name" && !isOp(end, ".") && !isOp(end, "(")) {
          names.modules.set(target.value, module.value);
          names.assignedModuleOffsets.add(value.start);
        }
      }
    }
  }
  return names;
}

/**
 * Whether the receiver ending at `tokens[end]` can be traced to dbutils: a name
 * dbutils goes by (`dbutils`, `self.dbutils`, `w.dbutils`, `dbu = dbutils`), or a
 * call that returns it (`DBUtils(spark)`, `get_dbutils(spark)`).
 */
function isDbutilsReceiver(tokens: PythonToken[], end: number, names: DbutilsNames): boolean {
  const receiver = tokens[end];
  if (receiver?.kind === "name") return names.dbutils.has(receiver.value);
  if (!isOp(receiver, ")")) return false;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (isOp(tokens[i], ")")) depth += 1;
    else if (isOp(tokens[i], "(")) {
      depth -= 1;
      if (depth === 0) {
        const callee = tokens[i - 1];
        return callee?.kind === "name" && names.factories.has(callee.value);
      }
    }
  }
  return false;
}

interface DbutilsCall {
  method: string;
  args: PythonArgument[];
  offset: number;
  /** Offset just past the call's closing `)`. */
  end: number;
  /** Index of the token after the closing `)`. */
  after: number;
  /** Whether the receiver can be traced to dbutils (see {@link isDbutilsReceiver}). */
  knownReceiver: boolean;
}

/**
 * Finds calls to `<receiver>.<module>.<method>(...)` in Python code. dbutils can
 * reach code under any name (a function parameter, an attribute, a helper's return
 * value), so the receiver can be anything: `dbutils`, `dbu`, `self.dbutils`,
 * `get_dbutils(spark)`. Variables holding the module itself (`w = dbutils.widgets`)
 * are followed through {@link dbutilsNames}.
 *
 * @returns Each call's method, its arguments, where it starts, and whether its
 *   receiver is known to be dbutils.
 */
function dbutilsCalls(
  tokens: PythonToken[],
  module: string,
  methods: readonly string[],
  names: DbutilsNames = dbutilsNames(tokens),
): DbutilsCall[] {
  const calls: DbutilsCall[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let methodIndex: number;
    let knownReceiver: boolean;
    let offset = token.start;
    // `<receiver>.<module>.<method>(`: the receiver ends in a name, `)` or `]`.
    if (
      isOp(token, ".") &&
      tokens[i + 1]?.kind === "name" &&
      tokens[i + 1]!.value === module &&
      isOp(tokens[i + 2], ".")
    ) {
      const receiver = tokens[i - 1];
      if (!receiver || !(receiver.kind === "name" || isOp(receiver, ")") || isOp(receiver, "]"))) continue;
      methodIndex = i + 3;
      knownReceiver = isDbutilsReceiver(tokens, i - 1, names);
      offset = receiver.start;
    } else if (token.kind === "name" && names.modules.get(token.value) === module && !isOp(tokens[i - 1], ".")) {
      // `<module variable>.<method>(`
      if (!isOp(tokens[i + 1], ".")) continue;
      methodIndex = i + 2;
      knownReceiver = true;
    } else {
      continue;
    }
    const method = tokens[methodIndex];
    if (method?.kind !== "name" || !methods.includes(method.value)) continue;
    if (!isOp(tokens[methodIndex + 1], "(")) continue;
    const call = readArguments(tokens, methodIndex + 1);
    if (!call) continue;
    calls.push({ method: method.value, args: call.args, offset, end: tokens[call.close]!.end, after: call.close + 1, knownReceiver });
  }
  return calls;
}

/** The files' code, one view per language; see {@link notebookViews}. */
function viewsFor(
  filePath: string,
  content: string,
  fileTypeHint?: "sql" | "python" | "notebook",
): NotebookViews {
  const ext = path.extname(filePath).toLowerCase();
  return notebookViews(content, {
    jupyter: fileTypeHint === "notebook" || ext === ".ipynb",
    fileLanguage: fileTypeHint === "sql" || ext === ".sql" ? "sql" : "python",
  });
}

/**
 * `dbutils.secrets.get(...)`, `dbutils.secrets.getBytes(...)` and `dbutils.secrets.list(...)` calls in Python code
 * (not comments or strings, including multi-line and triple-quoted ones). Scope and
 * key come from `scope=` / `key=` or the first and second positional arguments, and
 * are `null` when not a string literal. `list` takes only a scope, so its key is `null`;
 * it fails the same way as `get` when the scope does not exist (#236).
 */
function scanPythonSecrets(view: string, document: string): SecretDetection[] {
  const tokens = tokenizePython(view);
  const names = dbutilsNames(tokens);
  const parameterOf = scopeParameterReader(tokens, names);
  const detection = (call: { args: PythonArgument[]; offset: number }): SecretDetection => {
    const scopeArgument = argument(call.args, "scope", 0);
    const scope = literalValue(scopeArgument);
    const parameter = scope === null ? parameterOf(scopeArgument) : undefined;
    return {
      line: getStartLine(document, call.offset),
      raw: getLineText(document, call.offset),
      scope,
      key: literalValue(argument(call.args, "key", 1)),
      ...(parameter ? { scopeParameter: parameter } : {}),
    };
  };
  // Only calls on something traceable to dbutils: `settings.secrets.get("db", "pw")`
  // on a plain object has the same shape. In Databricks' own examples every
  // `.secrets.get` is called on `dbutils` itself.
  const secretCalls = dbutilsCalls(tokens, "secrets", ["get", "getBytes", "list"], names).filter(
    (call) => call.knownReceiver,
  );
  return [...secretCalls, ...sdkSecretCalls(tokens, names)]
    .sort((a, b) => a.offset - b.offset)
    .map(detection);
}

/**
 * The notebook parameter a secret's scope argument comes from, when the file shows it plainly
 * (issue 535): the argument is `dbutils.widgets.get("x")` itself, or a name assigned from such a
 * call once in the file, and never assigned or bound any other way. Anything else, such as an
 * f-string, a function's argument or a name set twice, has no parameter: its value is only known
 * at run time.
 */
function scopeParameterReader(tokens: PythonToken[], names: DbutilsNames): (arg: PythonArgument | undefined) => string | undefined {
  const reads = dbutilsCalls(tokens, "widgets", ["get", "getArgument"], names).filter((call) => call.knownReceiver);
  const readAt = new Map(reads.map((call) => [call.offset, call]));
  const widgetName = (call: DbutilsCall | undefined) => (call ? literalValue(argument(call.args, "name", 0)) ?? undefined : undefined);
  // Each name's plain assignments, and names bound some other way (loops, `as`, augmented
  // assignment, tuple targets, parameters), which make its value unknowable here.
  const assigned = new Map<string, Array<string | undefined>>();
  const boundOtherwise = new Set<string>();
  tokens.forEach((token, i) => {
    if (token.kind !== "name") return;
    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    if (previous?.kind === "name" && ["for", "as", "def", "global", "nonlocal", "lambda"].includes(previous.value)) boundOtherwise.add(token.value);
    // `a, b = ...` and `x += ...`.
    // A tuple target starts a statement, so the token before it ends the one before (or there is none).
    const startsStatement = !previous || previous.kind !== "op" || ")]}".includes(previous.value);
    if (isOp(next, ",") && startsStatement) boundOtherwise.add(token.value);
    if (next?.kind === "op" && "+-*/%|&^@<>".includes(next.value) && isOp(tokens[i + 2], "=")) boundOtherwise.add(token.value);
    // `name := ...`
    if (isOp(next, ":") && isOp(tokens[i + 2], "=")) boundOtherwise.add(token.value);
    // Every name in a `def f(...)` parameter list: a function's own `scope` is not the file's.
    if (previous?.kind === "name" && previous.value === "def" && isOp(next, "(")) {
      const params = readArguments(tokens, i + 1);
      for (const param of params?.args ?? []) {
        const name = param.keyword ?? param.tokens.find((t) => t.kind === "name")?.value;
        if (name) boundOtherwise.add(name);
      }
    }
    if (!isOp(next, "=") || isOp(tokens[i + 2], "=")) return;
    if (previous && previous.kind === "op" && "(,.=".includes(previous.value)) return;
    const value = tokens[i + 2];
    const call = value ? readAt.get(value.start) : undefined;
    // Only `name = dbutils.widgets.get("x")` with nothing after the call.
    const whole = call && !(tokens[call.after]?.kind === "op" && ".[(+-*/%|&^@<>=".includes(tokens[call.after]!.value));
    const list = assigned.get(token.value) ?? [];
    list.push(whole ? widgetName(call) : undefined);
    assigned.set(token.value, list);
  });
  return (arg) => {
    const first = arg?.tokens[0];
    const last = arg?.tokens[arg.tokens.length - 1];
    if (!first || !last) return undefined;
    const direct = readAt.get(first.start);
    if (direct && direct.end === last.end) return widgetName(direct);
    if (arg!.tokens.length !== 1 || first.kind !== "name" || boundOtherwise.has(first.value)) return undefined;
    const values = assigned.get(first.value);
    return values?.length === 1 ? values[0] : undefined;
  };
}

/**
 * The Databricks SDK's Secrets API: `w.secrets.get_secret(scope, key)` on a
 * `WorkspaceClient` variable, or `WorkspaceClient().secrets.get_secret(...)`.
 */
function sdkSecretCalls(
  tokens: PythonToken[],
  names: DbutilsNames,
): Array<{ args: PythonArgument[]; offset: number }> {
  const calls: Array<{ args: PythonArgument[]; offset: number }> = [];
  tokens.forEach((token, i) => {
    if (token.kind !== "name") return;
    let secretsIndex: number;
    if (names.workspaceClients.has(token.value) && !isOp(tokens[i - 1], ".")) {
      secretsIndex = i + 2;
      if (!isOp(tokens[i + 1], ".")) return;
    } else if (names.clientClasses.has(token.value) && isOp(tokens[i + 1], "(")) {
      const client = readArguments(tokens, i + 1);
      if (!client || !isOp(tokens[client.close + 1], ".")) return;
      secretsIndex = client.close + 2;
    } else {
      return;
    }
    if (tokens[secretsIndex]?.value !== "secrets" || !isOp(tokens[secretsIndex + 1], ".")) return;
    if (tokens[secretsIndex + 2]?.value !== "get_secret" || !isOp(tokens[secretsIndex + 3], "(")) return;
    const call = readArguments(tokens, secretsIndex + 3);
    if (call) calls.push({ args: call.args, offset: token.start });
  });
  return calls;
}

const SQL_PREVIEW_NOTE =
  "secret() and try_secret() are Databricks SQL preview features";

/** The arguments of a SQL call whose `(` is at `tokens[open]`, split on top-level commas. */
function sqlArguments(tokens: SqlToken[], open: number): SqlToken[][] {
  const args: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "op" && token.value === "(") {
      depth += 1;
      if (depth === 1) continue;
    } else if (token.kind === "op" && token.value === ")") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && token.kind === "op" && token.value === ",") {
      args.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) args.push(current);
  return args;
}

function sqlLiteral(arg: SqlToken[] | undefined): string | null {
  return arg?.length === 1 && arg[0]!.kind === "string" && arg[0]!.value !== ""
    ? arg[0]!.value
    : null;
}

/**
 * `secret(scope, key)` and `try_secret(scope, key)` calls in SQL code. Both
 * arguments must be string literals per the Databricks SQL spec. Every detection
 * carries {@link SQL_PREVIEW_NOTE}.
 */
function scanSqlSecrets(view: string, document: string): SecretDetection[] {
  const tokens = tokenizeSql(view);
  const detections: SecretDetection[] = [];
  tokens.forEach((token, i) => {
    const name = token.kind === "word" ? token.value.toLowerCase() : "";
    if (name !== "secret" && name !== "try_secret") return;
    if (tokens[i + 1]?.value !== "(") return;
    const [scope, key] = sqlArguments(tokens, i + 1);
    detections.push({
      line: getStartLine(document, token.start),
      raw: getLineText(document, token.start),
      scope: sqlLiteral(scope),
      key: sqlLiteral(key),
      note: SQL_PREVIEW_NOTE,
    });
  });
  return detections;
}

const WIDGET_DEPRECATED_NOTE =
  "dbutils.widgets.getArgument() is deprecated; use dbutils.widgets.get() instead";

/** The retrieval method that produced a {@link WidgetDetection}. */
/**
 * Python: `get`, `getArgument` (deprecated) and `getAll`. SQL: a `:name` parameter
 * marker, or the legacy `${name}` reference (deprecated in DBR 15.2+).
 */
export type WidgetMethod =
  | "get"
  | "getArgument"
  | "getAll"
  | "sqlParameterMarker"
  | "sqlLegacyReference"
  | "sqlGetArgument";

/**
 * A single detected use of a Databricks widget-retrieval call within a file.
 * Covers `dbutils.widgets.get()`, `dbutils.widgets.getArgument()` (deprecated),
 * and `dbutils.widgets.getAll()` in Python files and notebooks.
 */
export interface WidgetDetection {
  /** 1-based line number where the call starts. */
  line: number;
  /** The source line on which the call appears. */
  raw: string;
  /**
   * The literal widget name when it can be determined statically, or `null`
   * when the name is a variable resolved at runtime, or when `method` is
   * `"getAll"` (which returns all widgets rather than a named one).
   */
  name: string | null;
  /** Which retrieval method was used. */
  method: WidgetMethod;
  /**
   * Optional human-readable note — present on `getArgument` detections to
   * flag that the method is deprecated.
   */
  note?: string;
}

/**
 * `dbutils.widgets.get(...)`, `getArgument(...)` and `getAll()` calls in Python code.
 * The name is the `name=` or first positional argument when it is a string literal.
 */
function scanPythonWidgets(view: string, document: string): WidgetDetection[] {
  return dbutilsCalls(tokenizePython(view), "widgets", ["get", "getArgument", "getAll"]).map(
    (call) => {
      const method = call.method as WidgetMethod;
      const detection: WidgetDetection = {
        line: getStartLine(document, call.offset),
        raw: getLineText(document, call.offset),
        // A read on something not traceable to dbutils isn't claimed as a named read,
        // but still marks the notebook as reading widgets the inspector can't check.
        name:
          method === "getAll" || !call.knownReceiver
            ? null
            : literalValue(argument(call.args, "name", 0)),
        method,
      };
      if (method === "getArgument") detection.note = WIDGET_DEPRECATED_NOTE;
      return detection;
    },
  );
}

/**
 * Widgets created with a default in Python: `text`, `dropdown`, `combobox`, `multiselect`.
 * Counted whatever the receiver is: a default can only suppress a warning.
 */
function scanPythonWidgetDefaults(view: string): string[] {
  return dbutilsCalls(tokenizePython(view), "widgets", [
    "text",
    "dropdown",
    "combobox",
    "multiselect",
  ]).flatMap((call) => {
    const name = literalValue(argument(call.args, "name", 0));
    return name ? [name] : [];
  });
}

/** `dbutils.widgets` used as a value, not followed by a method call. */
/** Whether `tokens[index]` is a name in `from x import (a, b)`. */
function inImportList(tokens: PythonToken[], index: number): boolean {
  for (let j = index - 1; j >= 0; j--) {
    const token = tokens[j]!;
    if (token.kind === "name" && token.value === "import") return true;
    if (!(token.kind === "name" || isOp(token, ",") || isOp(token, "("))) return false;
  }
  return false;
}

function passesWidgetsObject(view: string): boolean {
  const tokens = tokenizePython(view);
  const names = dbutilsNames(tokens);
  return tokens.some((token, i) => {
    if (token.kind !== "name") return false;
    // dbutils itself handed to other code, `run(dbutils)` or `run(dbu=dbutils)`,
    // which can read widgets where the inspector can't see.
    if (
      names.dbutils.has(token.value) &&
      !inImportList(tokens, i) &&
      !isOp(tokens[i - 1], ".") &&
      (isOp(tokens[i - 1], "(") || isOp(tokens[i - 1], ",") || (isOp(tokens[i - 1], "=") && tokens[i - 2]?.kind === "name" && (isOp(tokens[i - 3], "(") || isOp(tokens[i - 3], ",")))) &&
      (isOp(tokens[i + 1], ")") || isOp(tokens[i + 1], ","))
    ) {
      return true;
    }
    // `dbutils.widgets` passed on, but not `w = dbutils.widgets`, which is followed instead.
    if (
      names.dbutils.has(token.value) &&
      isOp(tokens[i + 1], ".") &&
      tokens[i + 2]?.value === "widgets" &&
      !isOp(tokens[i + 3], ".")
    ) {
      return !names.assignedModuleOffsets.has(token.start);
    }
    // A variable holding dbutils.widgets, passed on: `helper(w)`.
    return (
      names.modules.get(token.value) === "widgets" &&
      !isOp(tokens[i - 1], ".") &&
      !isOp(tokens[i + 1], ".") &&
      !isOp(tokens[i + 1], "=")
    );
  });
}

const WIDGET_NAME = /^[A-Za-z_]\w*$/;
const LEGACY_NOTE = "${param} is deprecated in Databricks Runtime 15.2 and above; use :param";
// Keywords after which an expression starts, so a `:name` there is a parameter.
// After any other word (a column, a function's result) a colon is a JSON path.
const EXPRESSION_START_KEYWORDS = new Set([
  "ALL", "AND", "ANY", "AS", "BETWEEN", "BY", "CASE", "COMMENT", "DATE", "DECLARE",
  "DEFAULT", "DISTINCT", "ELSE", "ESCAPE", "EXCEPT", "EXECUTE", "EXISTS", "FROM",
  "GROUP", "HAVING", "IF", "ILIKE", "IMMEDIATE", "IN", "INTERSECT", "INTERVAL", "INTO",
  "IS", "JOIN", "LIKE", "LIMIT", "LOCATION", "MINUS", "NOT", "OFFSET", "ON", "OPTIONS",
  "OR", "ORDER", "PARTITION", "QUALIFY", "REGEXP", "RETURN", "RLIKE", "SELECT", "SET",
  "SOME", "TABLE", "TBLPROPERTIES", "THEN", "TIMESTAMP", "TIMESTAMP_NTZ", "TO", "UNION",
  "USING", "VALUES", "VAR", "VARIABLE", "WHEN", "WHERE", "WITH",
]);

/** Whether a token ends an expression, so a `:` after it is a JSON path (`details :a.b`). */
function endsExpression(token: SqlToken): boolean {
  if (token.kind === "word") return !EXPRESSION_START_KEYWORDS.has(token.value.toUpperCase());
  if (token.kind === "op") return token.value === ")" || token.value === "]";
  return true;
}

/**
 * Widget reads and defaults in SQL code
 * (https://docs.databricks.com/aws/en/notebooks/widgets):
 *
 * - `:name` parameter markers, where an expression starts: after `=`, `(`, `,` or a
 *   keyword such as `WHERE` or `LIMIT`, and in `IDENTIFIER(:name)`. Not `::` casts, and
 *   not JSON paths, where the colon follows an expression (`raw:owner`, `details :a.b`)
 *   or the name continues with `.` or `[`.
 * - Legacy `${name}` references, in code, strings or backtick identifiers.
 * - `CREATE WIDGET TEXT|DROPDOWN|COMBOBOX|MULTISELECT name DEFAULT ...` sets a default.
 */
function scanSqlWidgets(view: string, document: string): { reads: WidgetDetection[]; defaults: string[] } {
  const tokens = tokenizeSql(view);
  const reads: WidgetDetection[] = [];
  const legacy: WidgetDetection[] = [];
  const defaults: string[] = [];
  const at = (offset: number) => ({
    line: getStartLine(document, offset),
    raw: getLineText(document, offset),
  });

  tokens.forEach((token, i) => {
    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    if (token.kind === "op" && token.value === ":") {
      const afterName = tokens[i + 2];
      const isJsonPath =
        (previous !== undefined && endsExpression(previous)) ||
        (afterName?.kind === "op" && (afterName.value === "." || afterName.value === "[") && afterName.start === next?.end);
      if (!isJsonPath && next?.kind === "word" && next.start === token.end && WIDGET_NAME.test(next.value)) {
        reads.push({ ...at(token.start), name: next.value, method: "sqlParameterMarker" });
      }
    }
    // Deprecated `getArgument('name')`, which reads a widget from SQL.
    if (token.kind === "word" && token.value.toLowerCase() === "getargument" && next?.value === "(") {
      const name = sqlLiteral(sqlArguments(tokens, i + 1)[0]);
      reads.push({
        ...at(token.start),
        name,
        method: "sqlGetArgument",
        note: "getArgument() is deprecated; use :param",
      });
    }
    if (token.kind === "legacy_reference" && WIDGET_NAME.test(token.value)) {
      legacy.push({ ...at(token.start), name: token.value, method: "sqlLegacyReference", note: LEGACY_NOTE });
    }
    if (token.kind === "string" || token.kind === "quoted_identifier") {
      for (const reference of legacyReferencesInString(token)) {
        if (!WIDGET_NAME.test(reference.name)) continue;
        legacy.push({ ...at(reference.offset), name: reference.name, method: "sqlLegacyReference", note: LEGACY_NOTE });
      }
    }
    if (
      token.kind === "word" &&
      token.value.toUpperCase() === "CREATE" &&
      next?.kind === "word" &&
      next.value.toUpperCase() === "WIDGET" &&
      /^(TEXT|DROPDOWN|COMBOBOX|MULTISELECT)$/i.test(tokens[i + 2]?.value ?? "")
    ) {
      const name = tokens[i + 3];
      if ((name?.kind === "word" || name?.kind === "quoted_identifier") && WIDGET_NAME.test(name.value)) {
        defaults.push(name.value);
      }
    }
  });

  legacy.sort((a, b) => a.line - b.line);
  return { reads: [...reads, ...legacy].sort((a, b) => a.line - b.line), defaults };
}

function byLine<T extends { line: number }>(a: T, b: T): number {
  return a.line - b.line;
}

/**
 * Scans a local file for secret-access calls and returns one
 * {@link SecretDetection} per call found in executable code.
 *
 * | Code                  | Detected call                          |
 * |-----------------------|----------------------------------------|
 * | Python (`.py`, `.ipynb`, `%python` cells) | `dbutils.secrets.get()`, `.getBytes()`, `.list()` |
 * | SQL (`.sql`, `%sql` cells)                | `secret()`, `try_secret()`             |
 *
 * Notebooks are read cell by cell in each cell's language, so a `%sql` cell in a
 * Python notebook is read as SQL. Line numbers count every cell in document order.
 *
 * `null` on `scope` or `key` means that argument is not a string literal.
 * SQL detections always carry a `note` marking the preview status.
 */
export async function detectSecretInNotebook(
  filePath: string,
  fileTypeHint?: "sql" | "python" | "notebook",
): Promise<SecretDetection[]> {
  const views = viewsFor(filePath, await fs.readFile(filePath, "utf8"), fileTypeHint);
  return [
    ...scanPythonSecrets(views.python, views.document),
    ...scanSqlSecrets(views.sql, views.document),
  ].sort(byLine);
}

/**
 * Scans a local file for widget reads and returns one {@link WidgetDetection} per
 * read found in executable code: `dbutils.widgets.get()`, `.getArgument()` and
 * `.getAll()` in Python, `:name` and legacy `${name}` in SQL.
 *
 * `null` on `name` means the argument is not a string literal, or the method is
 * `getAll` (which retrieves every widget, not a named one).
 */
export async function detectWidgetsInFile(
  filePath: string,
  fileTypeHint?: "sql" | "python" | "notebook",
): Promise<WidgetDetection[]> {
  const views = viewsFor(filePath, await fs.readFile(filePath, "utf8"), fileTypeHint);
  return [
    ...scanPythonWidgets(views.python, views.document),
    ...scanSqlWidgets(views.sql, views.document).reads,
  ].sort(byLine);
}

/** A dotted name written in code, such as `workspace.sales.orders`, split into its parts. */
export interface QualifiedName {
  parts: string[];
  line: number;
}

const DOTTED_IN_TEXT = /[A-Za-z_`][\w`]*(?:\.[A-Za-z_`][\w`]*)+/g;

/** The dotted names inside a string's text (`"SELECT * FROM main.sales.orders"`). */
function dottedNamesIn(text: string, offset: number, document: string): QualifiedName[] {
  return [...text.matchAll(DOTTED_IN_TEXT)].map((match) => ({
    parts: match[0].split(".").map((part) => part.replace(/`/g, "")),
    line: getStartLine(document, offset + match.index!),
  }));
}

/**
 * Dotted names written in a file's code, for checks that look for a name the bundle
 * defines (issue 235): in SQL, names like `main.sales.orders` and those inside strings;
 * in Python, those inside strings, where table names are written. Never comments.
 */
export async function detectQualifiedNamesInFile(
  filePath: string,
  fileTypeHint?: "sql" | "python" | "notebook",
): Promise<QualifiedName[]> {
  const views = viewsFor(filePath, await fs.readFile(filePath, "utf8"), fileTypeHint);
  const names: QualifiedName[] = [];
  const sql = tokenizeSql(views.sql);
  for (let i = 0; i < sql.length; i++) {
    const token = sql[i]!;
    if (token.kind === "string") {
      names.push(...dottedNamesIn(token.value, token.bodyStart ?? token.start, views.document));
      continue;
    }
    if (token.kind !== "word" && token.kind !== "quoted_identifier") continue;
    // A run of identifiers joined by dots with nothing between them: a.b, `a`.b.c
    const parts = [token.value];
    let j = i;
    while (sql[j + 1]?.value === "." && sql[j + 1]!.kind === "op" && sql[j + 1]!.start === sql[j]!.end) {
      const next = sql[j + 2];
      if (!next || (next.kind !== "word" && next.kind !== "quoted_identifier") || next.start !== sql[j + 1]!.end) break;
      parts.push(next.value);
      j += 2;
    }
    if (parts.length > 1) names.push({ parts, line: getStartLine(views.document, token.start) });
    i = j;
  }
  for (const token of tokenizePython(views.python)) {
    if (token.kind === "string") names.push(...dottedNamesIn(token.value, token.start, views.document));
  }
  return names.sort(byLine);
}

/**
 * The named parameter markers (`:name`) a SQL file run by a SQL file task reads, in order,
 * one per marker. The task's `sql_task.parameters` and the job's parameters fill them; one
 * neither passes fails the run with UNBOUND_SQL_PARAMETER (tested on a serverless SQL
 * warehouse, CLI v1.24.0, issue 234). Not casts (`x::int`), JSON paths, comments or
 * strings, and not legacy `${name}` text, which this check has not tested.
 */
export async function detectSqlParameterMarkersInFile(filePath: string): Promise<Array<{ name: string; line: number }>> {
  const views = viewsFor(filePath, await fs.readFile(filePath, "utf8"), "sql");
  return scanSqlWidgets(views.sql, views.document)
    .reads.filter((read) => read.method === "sqlParameterMarker" && read.name)
    .map((read) => ({ name: read.name!, line: read.line }));
}

/** A `{{name}}` text parameter in a SQL file (#484), with where it sits. */
export interface SqlTextParameter {
  name: string;
  line: number;
  /** 1-based columns of `{{name}}` itself: `endColumn` is the column just after it. */
  column: number;
  endColumn: number;
  /** Inside a string, where an unpassed one stays as text and the query still runs. */
  inString: boolean;
  /** The whole string is `'{{name}}'`: a passed value, already quoted, makes `''value''`. */
  wholeString: boolean;
}

const TEXT_PARAMETER_NAME = /^[A-Za-z_]\w*$/;
const TEXT_PARAMETER_IN_STRING = /\{\{([A-Za-z_]\w*)\}\}/g;

/**
 * The `{{name}}` text parameters a SQL file run by a SQL file task uses, in order, one per
 * use. The task's `sql_task.parameters` and the job's parameters fill them by pasting in the
 * value already quoted; an unpassed one stays as written (tested on a serverless SQL warehouse,
 * CLI v1.27.0, issue 484). Only the exact form with a plain name: not `{{ name }}` with spaces
 * or dotted names such as `{{job.start_time}}`, which were not tested, and never comments.
 */
export async function detectSqlTextParametersInFile(filePath: string): Promise<SqlTextParameter[]> {
  const views = viewsFor(filePath, await fs.readFile(filePath, "utf8"), "sql");
  const document = views.document;
  const at = (offset: number) => ({ line: getStartLine(document, offset), column: offset - document.lastIndexOf("\n", offset - 1) });
  const found: SqlTextParameter[] = [];
  const tokens = tokenizeSql(views.sql);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "string") {
      const body = token.bodyStart ?? token.start;
      // A plain quoted string (not r'...' or $$...$$) that holds only the parameter.
      const wholeString = token.end - token.start === token.value.length + 2 && /^\{\{[A-Za-z_]\w*\}\}$/.test(token.value);
      for (const match of token.value.matchAll(TEXT_PARAMETER_IN_STRING)) {
        const { line, column } = at(body + match.index!);
        found.push({ name: match[1]!, line, column, endColumn: column + match[0].length, inString: true, wholeString });
      }
      continue;
    }
    // In code: `{` `{` name `}` `}`, written with nothing between them.
    const parts = tokens.slice(i, i + 5);
    if (
      parts.length === 5 &&
      parts[0]!.value === "{" && parts[1]!.value === "{" && parts[3]!.value === "}" && parts[4]!.value === "}" &&
      parts.slice(0, 4).every((part) => part.kind === "op" || part.kind === "word") &&
      parts[2]!.kind === "word" && TEXT_PARAMETER_NAME.test(parts[2]!.value) &&
      parts.every((part, k) => k === 0 || part.start === parts[k - 1]!.end)
    ) {
      const { line, column } = at(token.start);
      found.push({ name: parts[2]!.value, line, column, endColumn: column + (parts[4]!.end - token.start), inString: false, wholeString: false });
      i += 4;
    }
  }
  return found;
}

/**
 * How a notebook reads its parameters: the widgets it reads by name, the widgets it
 * gives a default, and whether it pulls in other notebooks with `%run`, which can
 * define widgets the inspector does not see.
 */
export interface WidgetUsage {
  reads: Array<{ name: string; line: number; language: CodeLanguage }>;
  /**
   * Widgets created with a default: `text`, `dropdown`, `combobox`, `multiselect` in
   * Python, `CREATE WIDGET` in SQL. Includes widgets created by notebooks run with `%run`.
   */
  defaults: string[];
  /**
   * The language of the cells that create each of this notebook's own defaults. A widget
   * created in one language can't be read in another when the notebook runs as a job
   * (https://docs.databricks.com/aws/en/notebooks/notebook-limitations).
   */
  defaultLanguages: Record<string, CodeLanguage[]>;
  /**
   * Reads whose names the inspector can't know: a name held in a variable, `getAll()`,
   * or `dbutils.widgets` passed to other code, e.g. `helper(widgets=dbutils.widgets)`.
   */
  hasDynamicReads: boolean;
  /**
   * A `%run` the inspector could not follow: a workspace path, a missing file, or
   * one nested too deep. That notebook can define widgets the inspector does not see.
   */
  hasUnresolvedRuns: boolean;
  /** Widget names read by notebooks this one runs with `%run`. */
  runReadNames: string[];
  /**
   * Widgets read by a notebook run with `%run` that neither the `%run` line passes
   * (`$name="value"`) nor that notebook gives a default. `%run` runs a notebook with
   * its own widget defaults (https://docs.databricks.com/aws/en/notebooks/widgets).
   */
  unsetRunReads: Array<{ name: string; line: number; file: string; target: string }>;
  /**
   * The local notebooks this one's `%run` lines point at, at any depth, found or not: each as
   * the path written (`./child` → `<folder>/child`) and, when found, the file itself. Saving,
   * creating or deleting one changes what the widget checks find, so they are watched.
   */
  runFiles: string[];
}

/** Notebooks the widget scan can read; R and Scala notebooks are not scanned. */
const SCANNED_NOTEBOOK_EXTENSIONS = [".py", ".sql", ".ipynb"];
const MAX_RUN_DEPTH = 5;

/**
 * The local notebook a `%run` path points at, found the same way as the run-target
 * check (runTargets.ts), so both read the same file: `./two` with a plain two.py and a
 * notebook two.sql runs two.sql.
 */
function resolveRunTarget(fromFile: string, target: string, rule: NotebookHeaderRule): string | undefined {
  const check = checkRunTarget(fromFile, target, rule);
  if (check.status !== "notebook") return undefined;
  return SCANNED_NOTEBOOK_EXTENSIONS.includes(path.extname(check.file).toLowerCase()) ? check.file : undefined;
}

/**
 * Reads how a Python or SQL notebook takes widget parameters, following `%run` into
 * the notebooks it runs.
 */
export async function detectWidgetUsageInFile(
  filePath: string,
  fileTypeHint?: "sql" | "python" | "notebook",
  visited: ReadonlySet<string> = new Set([path.resolve(filePath)]),
  rule: NotebookHeaderRule = "contains",
): Promise<WidgetUsage> {
  const views = viewsFor(filePath, await fs.readFile(filePath, "utf8"), fileTypeHint);
  const python = scanPythonWidgets(views.python, views.document);
  const sql = scanSqlWidgets(views.sql, views.document);
  const pythonDefaults = scanPythonWidgetDefaults(views.python);
  const defaultLanguages = emptyRecord<CodeLanguage[]>();
  for (const [language, names] of [["python", pythonDefaults], ["sql", sql.defaults]] as const) {
    for (const name of names) defaultLanguages[name] = [...(own(defaultLanguages, name) ?? []), language];
  }
  const withLanguage = (language: CodeLanguage) => (d: WidgetDetection) =>
    d.name && d.method !== "getAll" ? [{ name: d.name, line: d.line, language }] : [];
  const usage: WidgetUsage = {
    reads: [...python.flatMap(withLanguage("python")), ...sql.reads.flatMap(withLanguage("sql"))].sort(byLine),
    defaults: [...pythonDefaults, ...sql.defaults],
    defaultLanguages,
    hasDynamicReads: python.some((d) => d.name === null) || passesWidgetsObject(views.python),
    hasUnresolvedRuns: false,
    runReadNames: [],
    unsetRunReads: [],
    runFiles: [],
  };

  for (const run of views.runs) {
    const written = unquote(run.target);
    if (written.startsWith("./") || written.startsWith("../")) usage.runFiles.push(path.resolve(path.dirname(filePath), written));
    const target = resolveRunTarget(filePath, run.target, rule);
    if (target) usage.runFiles.push(target);
    if (!target || visited.size > MAX_RUN_DEPTH) {
      usage.hasUnresolvedRuns = true;
      continue;
    }
    if (visited.has(target)) continue;
    let child: WidgetUsage;
    try {
      child = await detectWidgetUsageInFile(target, undefined, new Set([...visited, target]), rule);
    } catch {
      usage.hasUnresolvedRuns = true;
      continue;
    }
    // Widgets the run notebook defines exist for this notebook too.
    usage.defaults.push(...child.defaults);
    usage.hasDynamicReads ||= child.hasDynamicReads;
    usage.hasUnresolvedRuns ||= child.hasUnresolvedRuns;
    usage.runReadNames.push(...child.reads.map((read) => read.name), ...child.runReadNames);
    usage.unsetRunReads.push(...child.unsetRunReads);
    usage.runFiles.push(...child.runFiles);
    // A notebook that itself runs one we can't see may get its widgets from there.
    if (child.hasUnresolvedRuns || child.hasDynamicReads) continue;
    const childDefaults = new Set(child.defaults);
    const reported = new Set<string>();
    for (const read of child.reads) {
      if (hasOwnKey(run.args, read.name) || childDefaults.has(read.name) || reported.has(read.name)) continue;
      reported.add(read.name);
      usage.unsetRunReads.push({ name: read.name, line: read.line, file: target, target: run.target });
    }
  }
  return usage;
}

/**
 * How a task's code uses task values
 * (https://docs.databricks.com/aws/en/jobs/task-values): the keys it sets with
 * `dbutils.jobs.taskValues.set(key=..., value=...)` and the values it reads with
 * `dbutils.jobs.taskValues.get(taskKey=..., key=..., default=..., debugValue=...)`.
 * A `null` key or task key is not a string literal.
 */
export interface TaskValueUsage {
  sets: Array<{ key: string | null; line: number }>;
  gets: Array<{ taskKey: string | null; key: string | null; hasDefault: boolean; line: number }>;
  /** A `%run`, which can set task values in a notebook the scan doesn't cover. */
  runsOtherNotebooks: boolean;
}

/**
 * `<receiver>.jobs.taskValues.<set|get>(...)`, and whether the receiver can be traced
 * to dbutils (see {@link isDbutilsReceiver}).
 */
function taskValueCalls(
  tokens: PythonToken[],
): Array<{ method: string; args: PythonArgument[]; offset: number; knownReceiver: boolean }> {
  const names = dbutilsNames(tokens);
  const calls: Array<{ method: string; args: PythonArgument[]; offset: number; knownReceiver: boolean }> = [];
  tokens.forEach((token, i) => {
    if (!isOp(token, ".") || tokens[i + 1]?.value !== "jobs" || !isOp(tokens[i + 2], ".")) return;
    if (tokens[i + 3]?.value !== "taskValues" || !isOp(tokens[i + 4], ".")) return;
    const receiver = tokens[i - 1];
    if (!receiver || !(receiver.kind === "name" || isOp(receiver, ")") || isOp(receiver, "]"))) return;
    const method = tokens[i + 5];
    if (method?.kind !== "name" || (method.value !== "set" && method.value !== "get")) return;
    if (!isOp(tokens[i + 6], "(")) return;
    const call = readArguments(tokens, i + 6);
    if (call) {
      calls.push({
        method: method.value,
        args: call.args,
        offset: receiver.start,
        knownReceiver: isDbutilsReceiver(tokens, i - 1, names),
      });
    }
  });
  return calls;
}

/** Whether a `default` argument is given and is not the literal `None`. */
function givesDefault(arg: PythonArgument | undefined): boolean {
  if (!arg || arg.tokens.length === 0) return false;
  return !(arg.tokens.length === 1 && arg.tokens[0]!.kind === "name" && arg.tokens[0]!.value === "None");
}

export async function detectTaskValuesInFile(
  filePath: string,
  fileTypeHint?: "sql" | "python" | "notebook",
): Promise<TaskValueUsage> {
  const views = viewsFor(filePath, await fs.readFile(filePath, "utf8"), fileTypeHint);
  const usage: TaskValueUsage = { sets: [], gets: [], runsOtherNotebooks: views.runs.length > 0 };
  for (const call of taskValueCalls(tokenizePython(views.python))) {
    const line = getStartLine(views.document, call.offset);
    if (call.method === "set") {
      // A set on an unknown receiver makes the task's keys unknown, which only
      // suppresses warnings.
      usage.sets.push({ key: call.knownReceiver ? literalValue(argument(call.args, "key", 0)) : null, line });
    } else if (call.knownReceiver) {
      usage.gets.push({
        taskKey: literalValue(argument(call.args, "taskKey", 0)),
        key: literalValue(argument(call.args, "key", 1)),
        // A missing key raises ValueError unless a default is given, and `default=None`
        // still raises (tested on job runs, #586). `debugValue` only applies outside a job.
        hasDefault: givesDefault(argument(call.args, "default", 2)),
        line,
      });
    }
  }
  return usage;
}

export type SourceFormatNotebook = "SQLSourceNotebook" | "PythonSourceNotebook";
export type NoteBookType = "JupyterNotebook" | SourceFormatNotebook;

/**
 * Checks if a file is a Databricks Source format notebook or not
 * We only check for Python, SQL Source Notebooks or Jupyter notebooks for now
 *
 * @param filePath Absolute path to a `.py` or `.ipynb`, `sql` file.
 * @returns `JupyterNotebook` if the an ipynb notebook, `SQLNotebook` if it is a sql notebook,
 *  `PythonNotebook` if Python notebook else, undefined
 */
export async function getNotebookType(
  filePath: string,
): Promise<NoteBookType | undefined> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ipynb") return "JupyterNotebook";
  if (ext === ".py" || ext === ".sql") {
    // TODO: Do we need entire file to be read into memory
    const content = await fs.readFile(filePath, "utf8");
    const prefix = ext === ".sql" ? "--" : "#";
    const databricksSourceMatch = content.match(
      new RegExp(`^${prefix} Databricks notebook source`),
    );

    return databricksSourceMatch
      ? ext === ".sql"
        ? "SQLSourceNotebook"
        : "PythonSourceNotebook"
      : undefined;
  }
}

/**
 * A notebook another notebook runs: `%run ./helper` (a magic line) or
 * `dbutils.notebook.run("./child", 60)`. `target` is the path as written, or `null` when
 * it isn't a string literal (built at run time).
 */
export interface RunTarget {
  kind: "run" | "notebook_run";
  target: string | null;
  line: number;
  /** The notebook containing the call. */
  file: string;
}

/**
 * Every `%run` and `dbutils.notebook.run` in this notebook. Child notebooks are not
 * scanned: their relative run paths may depend on the calling context, and the
 * run-target check only reports findings in the task's own notebook. Calls on
 * something that isn't traceable to dbutils are left out, as for secrets.
 */
export async function detectRunTargetsInFile(
  filePath: string,
  fileTypeHint?: "sql" | "python" | "notebook",
): Promise<RunTarget[]> {
  const views = viewsFor(filePath, await fs.readFile(filePath, "utf8"), fileTypeHint);
  const file = path.resolve(filePath);
  const found: RunTarget[] = views.runs.map((run) => ({ kind: "run", target: run.target, line: run.line, file }));
  const tokens = tokenizePython(views.python);
  for (const call of dbutilsCalls(tokens, "notebook", ["run"]).filter((c) => c.knownReceiver)) {
    found.push({
      kind: "notebook_run",
      target: literalValue(argument(call.args, "path", 0)),
      line: getStartLine(views.document, call.offset),
      file,
    });
  }
  return found.sort((a, b) => a.line - b.line);
}

import fs from "node:fs/promises";
import path from "node:path";
import { notebookViews, type NotebookViews } from "./code/notebookViews.js";
import {
  literalValue,
  readArguments,
  tokenizePython,
  type PythonArgument,
  type PythonToken,
} from "./code/pythonTokenizer.js";
import { legacyReferencesInString, tokenizeSql, type SqlToken } from "./code/sqlTokenizer.js";

/**
 * A single detected use of a Databricks secret-access call within a file.
 * Covers `dbutils.secrets.get` in Python/Jupyter notebook/Source format notebooks and `secret()`/`try_secret()`
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
  /** Variable name to the dbutils module it holds (`widgets`, `secrets`, ...). */
  modules: Map<string, string>;
  /** Offsets of `dbutils.<module>` that only feed such an assignment. */
  assignedModuleOffsets: Set<number>;
}

const DBUTILS_FACTORIES = new Set(["DBUtils", "get_dbutils"]);

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
    modules: new Map(),
    assignedModuleOffsets: new Set(),
  };
  // `import ... dbutils as dbu`
  tokens.forEach((token, i) => {
    if (token.kind === "name" && token.value === "dbutils" && tokens[i + 1]?.value === "as") {
      const alias = tokens[i + 2];
      if (alias?.kind === "name") names.dbutils.add(alias.value);
    }
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
      if (value.value === "WorkspaceClient" && clientCall && chainEnd === clientCall.close + 1) {
        names.workspaceClients.add(target.value);
      } else if (chainEnd > i + 3 && last?.kind === "name" && last.value === "dbutils") {
        // `dbutils = w.dbutils` or `dbu = WorkspaceClient().dbutils`
        names.dbutils.add(target.value);
      } else if (names.dbutils.has(value.value) && !isOp(after, ".") && !isOp(after, "(")) {
        names.dbutils.add(target.value);
      } else if (DBUTILS_FACTORIES.has(value.value) && isOp(after, "(")) {
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
 * Finds calls to `dbutils.<module>.<method>(...)` in Python code, through any name
 * `dbutils` or the module goes by (see {@link dbutilsNames}).
 *
 * @returns Each call's method, its arguments and the offset where the call starts.
 */
function dbutilsCalls(
  tokens: PythonToken[],
  module: string,
  methods: readonly string[],
  names: DbutilsNames = dbutilsNames(tokens),
): Array<{ method: string; args: PythonArgument[]; offset: number }> {
  const calls: Array<{ method: string; args: PythonArgument[]; offset: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "name") continue;
    // `dbutils.<module>.<method>(` or `<module variable>.<method>(`
    let methodIndex: number;
    if (names.dbutils.has(token.value) && isOp(tokens[i + 1], ".") && tokens[i + 2]?.value === module) {
      methodIndex = i + 4;
      if (!isOp(tokens[i + 3], ".")) continue;
    } else if (names.modules.get(token.value) === module && !isOp(tokens[i - 1], ".")) {
      methodIndex = i + 2;
      if (!isOp(tokens[i + 1], ".")) continue;
    } else {
      continue;
    }
    const method = tokens[methodIndex];
    if (method?.kind !== "name" || !methods.includes(method.value)) continue;
    if (!isOp(tokens[methodIndex + 1], "(")) continue;
    const call = readArguments(tokens, methodIndex + 1);
    if (!call) continue;
    calls.push({ method: method.value, args: call.args, offset: token.start });
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
 * `dbutils.secrets.get(...)` and `dbutils.secrets.getBytes(...)` calls in Python code
 * (not comments or strings, including multi-line and triple-quoted ones). Scope and
 * key come from `scope=` / `key=` or the first and second positional arguments, and
 * are `null` when not a string literal.
 */
function scanPythonSecrets(view: string, document: string): SecretDetection[] {
  const tokens = tokenizePython(view);
  const names = dbutilsNames(tokens);
  const detection = (call: { args: PythonArgument[]; offset: number }): SecretDetection => ({
    line: getStartLine(document, call.offset),
    raw: getLineText(document, call.offset),
    scope: literalValue(argument(call.args, "scope", 0)),
    key: literalValue(argument(call.args, "key", 1)),
  });
  return [
    ...dbutilsCalls(tokens, "secrets", ["get", "getBytes"], names),
    ...sdkSecretCalls(tokens, names),
  ]
    .sort((a, b) => a.offset - b.offset)
    .map(detection);
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
    } else if (token.value === "WorkspaceClient" && isOp(tokens[i + 1], "(")) {
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
  | "sqlLegacyReference";

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
        name: method === "getAll" ? null : literalValue(argument(call.args, "name", 0)),
        method,
      };
      if (method === "getArgument") detection.note = WIDGET_DEPRECATED_NOTE;
      return detection;
    },
  );
}

/** Widgets created with a default in Python: `text`, `dropdown`, `combobox`, `multiselect`. */
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
function passesWidgetsObject(view: string): boolean {
  const tokens = tokenizePython(view);
  const names = dbutilsNames(tokens);
  return tokens.some((token, i) => {
    if (token.kind !== "name") return false;
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
 * | Python (`.py`, `.ipynb`, `%python` cells) | `dbutils.secrets.get()`, `.getBytes()` |
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

/**
 * How a notebook reads its parameters: the widgets it reads by name, the widgets it
 * gives a default, and whether it pulls in other notebooks with `%run`, which can
 * define widgets the inspector does not see.
 */
export interface WidgetUsage {
  reads: Array<{ name: string; line: number }>;
  /** Widgets created with a default: `text`, `dropdown`, `combobox`, `multiselect`. */
  defaults: string[];
  /**
   * Reads whose names the inspector can't know: a name held in a variable, `getAll()`,
   * or `dbutils.widgets` passed to other code, e.g. `helper(widgets=dbutils.widgets)`.
   */
  hasDynamicReads: boolean;
  runsOtherNotebooks: boolean;
}

/**
 * Reads how a Python or SQL notebook takes widget parameters.
 */
export async function detectWidgetUsageInFile(
  filePath: string,
  fileTypeHint?: "sql" | "python" | "notebook",
): Promise<WidgetUsage> {
  const views = viewsFor(filePath, await fs.readFile(filePath, "utf8"), fileTypeHint);
  const python = scanPythonWidgets(views.python, views.document);
  const sql = scanSqlWidgets(views.sql, views.document);
  return {
    reads: [...python, ...sql.reads].sort(byLine).flatMap((d) =>
      d.name && d.method !== "getAll" ? [{ name: d.name, line: d.line }] : [],
    ),
    defaults: [...scanPythonWidgetDefaults(views.python), ...sql.defaults],
    hasDynamicReads: python.some((d) => d.name === null) || passesWidgetsObject(views.python),
    runsOtherNotebooks: views.runsOtherNotebooks,
  };
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

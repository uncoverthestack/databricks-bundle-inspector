/**
 * What a Python file does with `dbutils`, read once from its syntax tree (#649), for every
 * check that reads code: widget, secret, task value and notebook run calls, each with its
 * arguments and whether its receiver is known to be `dbutils`.
 *
 * Names are followed through the file in order. `w = dbutils.widgets` makes `w.get("a")` a
 * widget read until `w` is assigned something else; `read = dbutils.widgets.get` makes
 * `read("a")` one too. A name used before any assignment (in a function defined above, say)
 * takes the value of its first assignment. Scopes are not told apart: a function's local
 * name counts as the file's.
 *
 * A receiver that can't be traced to `dbutils` is unknown, never assumed: an unknown
 * object's `.widgets.text("a")` doesn't create a default (#602).
 */
import { decodedString } from "./pythonTokenizer.js";
import { withPythonTree, type SyntaxNode } from "./pythonParser.js";

/** The parts of `dbutils` the checks read. `jobs.taskValues` is reached through `jobs`. */
export type DbutilsModule = "widgets" | "secrets" | "notebook" | "jobs.taskValues";

/** A call argument: `name=value`, a positional value, or `*args` / `**kwargs`. */
export interface PythonArgumentFact {
  keyword?: string;
  /** The string the value is when it is a plain string literal (not empty, not an f-string); else `null`. */
  value: string | null;
  /** The value is the literal `None`. */
  isNone: boolean;
  /** `*args` or `**kwargs`: the positions of later arguments are not known. */
  splat?: true;
  /**
   * The widget whose value this argument is, when the file shows it plainly (#535): the
   * argument is `dbutils.widgets.get("x")` itself, or a name assigned from such a read once
   * in the file and never bound any other way.
   */
  widgetRead?: string;
}

export interface PythonCallFact {
  /** `sdk.secrets` is the Databricks SDK's `WorkspaceClient().secrets`. */
  module: DbutilsModule | "sdk.secrets";
  method: string;
  args: PythonArgumentFact[];
  /** Offsets of the whole call in the text, `start` at its first character. */
  start: number;
  end: number;
  /** Whether the receiver is known to be `dbutils` (or, for `sdk.secrets`, a `WorkspaceClient`). */
  known: boolean;
}

export interface PythonFacts {
  /** In the order they appear. */
  calls: PythonCallFact[];
  /**
   * `dbutils`, `dbutils.widgets` or one of its methods is handed to other code (a call's
   * argument, a list, a `return`), which may read widgets by names the inspector can't see.
   */
  passesWidgets: boolean;
}

/** The argument called `keyword`, or else the positional one at `position`. After a `*args`, positions aren't known. */
export function argumentFact(args: readonly PythonArgumentFact[], keyword: string, position: number): PythonArgumentFact | undefined {
  const named = args.find((arg) => arg.keyword === keyword);
  if (named) return named;
  const positional = args.filter((arg) => arg.keyword === undefined);
  const splat = positional.findIndex((arg) => arg.splat);
  if (splat !== -1 && splat <= position) return undefined;
  return positional[position];
}

type Value =
  | { kind: "dbutils" }
  | { kind: "module"; module: DbutilsModule | "jobs" }
  | { kind: "method"; module: DbutilsModule; method: string }
  /** `DBUtils`, `get_dbutils`: called, they return dbutils. */
  | { kind: "factory" }
  | { kind: "clientClass" }
  | { kind: "client" }
  | { kind: "sdkSecrets" }
  | { kind: "sdkMethod"; method: string }
  | { kind: "unknown" };

const UNKNOWN: Value = { kind: "unknown" };
const DBUTILS: Value = { kind: "dbutils" };

/**
 * What a name is when nothing in the file assigns it. `DBUtils` is the class in
 * `pyspark.dbutils`; `get_dbutils` is not an API but the helper name Databricks examples use
 * to build one, so it is matched by convention.
 */
function builtin(name: string): Value {
  if (name === "dbutils") return DBUTILS;
  if (name === "DBUtils" || name === "get_dbutils") return { kind: "factory" };
  if (name === "WorkspaceClient") return { kind: "clientClass" };
  return UNKNOWN;
}

const DBUTILS_MODULES = new Set(["widgets", "secrets", "notebook", "jobs"]);

/**
 * How a name gets a value at one place in the file:
 * - `assign`: `name = value`, followed;
 * - `import`: `from x import y as name`, which is `y`'s builtin meaning;
 * - `other`: anything else (a loop, `as`, `+=`, a tuple target, `def`, `class`), unknown after it;
 * - `parameter`: a function's parameter. It doesn't change what the name is (a helper's
 *   `dbutils` parameter is still dbutils) but makes its value unknowable for #535.
 */
type Binding =
  | { how: "assign"; at: number; value: SyntaxNode }
  | { how: "import"; at: number; imported: string }
  | { how: "other"; at: number }
  | { how: "parameter"; at: number };

function child(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

/** Every identifier in a target such as `a, (b, c)` or `*rest`. */
function identifiersIn(node: SyntaxNode): SyntaxNode[] {
  if (node.type === "identifier") return [node];
  if (node.type === "attribute" || node.type === "subscript") return [];
  return namedChildren(node).flatMap(identifiersIn);
}

/** The names a parameter list binds, not names inside default values or types. */
function parameterNames(parameters: SyntaxNode): SyntaxNode[] {
  return namedChildren(parameters).flatMap((parameter) => {
    if (parameter.type === "identifier") return [parameter];
    if (parameter.type === "default_parameter" || parameter.type === "typed_default_parameter") {
      const name = child(parameter, "name");
      return name ? identifiersIn(name) : [];
    }
    if (parameter.type === "typed_parameter" || parameter.type === "list_splat_pattern" || parameter.type === "dictionary_splat_pattern") {
      return namedChildren(parameter).filter((c) => c.type === "identifier").slice(0, 1);
    }
    return identifiersIn(parameter);
  });
}

function collectBindings(root: SyntaxNode): Map<string, Binding[]> {
  const bindings = new Map<string, Binding[]>();
  const add = (name: string, binding: Binding) => {
    const list = bindings.get(name) ?? [];
    list.push(binding);
    bindings.set(name, list);
  };
  const other = (target: SyntaxNode | null, at: number) => {
    for (const id of target ? identifiersIn(target) : []) add(id.text, { how: "other", at });
  };
  const visit = (node: SyntaxNode) => {
    switch (node.type) {
      case "assignment": {
        const left = child(node, "left");
        const right = child(node, "right");
        if (left?.type === "identifier" && right && right.type !== "assignment") {
          add(left.text, { how: "assign", at: node.endIndex, value: right });
        } else if (right) {
          // `a, b = ...`, `a = b = ...`: not followed.
          other(left, node.endIndex);
        }
        break;
      }
      case "augmented_assignment":
        other(child(node, "left"), node.endIndex);
        break;
      case "for_statement":
      case "for_in_clause":
        other(child(node, "left"), node.startIndex);
        break;
      case "named_expression":
        other(child(node, "name"), node.endIndex);
        break;
      case "as_pattern_target":
        other(node, node.endIndex);
        break;
      case "function_definition":
      case "class_definition":
        other(child(node, "name"), node.startIndex);
        break;
      case "parameters":
      case "lambda_parameters":
        for (const id of parameterNames(node)) add(id.text, { how: "parameter", at: node.startIndex });
        break;
      case "global_statement":
      case "nonlocal_statement":
        for (const id of namedChildren(node)) add(id.text, { how: "parameter", at: node.startIndex });
        break;
      case "import_from_statement":
      case "import_statement":
        for (const name of node.childrenForFieldName("name")) {
          if (!name) continue;
          if (name.type === "aliased_import") {
            const imported = child(name, "name")?.text ?? "";
            const alias = child(name, "alias");
            if (alias) add(alias.text, node.type === "import_from_statement" ? { how: "import", at: node.endIndex, imported } : { how: "other", at: node.endIndex });
          } else if (node.type === "import_from_statement") {
            add(name.text, { how: "import", at: node.endIndex, imported: name.text });
          } else {
            // `import a.b` binds `a`, a module.
            const first = name.type === "dotted_name" ? namedChildren(name)[0] : name;
            if (first) add(first.text, { how: "other", at: node.endIndex });
          }
        }
        break;
    }
    for (const c of namedChildren(node)) visit(c);
  };
  visit(root);
  for (const list of bindings.values()) list.sort((a, b) => a.at - b.at);
  return bindings;
}

/** A string literal's value, or `null` for anything else (an f-string, a variable, an empty string). */
function literalOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  let value: string | null;
  if (node.type === "string") value = stringValue(node);
  else if (node.type === "concatenated_string") {
    const parts = namedChildren(node).map(stringValue);
    value = parts.every((part): part is string => part !== null) ? parts.join("") : null;
  } else if (node.type === "parenthesized_expression") {
    const inner = namedChildren(node);
    return inner.length === 1 ? literalOf(inner[0]!) : null;
  } else return null;
  return value === "" ? null : value;
}

function stringValue(node: SyntaxNode): string | null {
  if (node.type !== "string" || node.hasError || namedChildren(node).some((c) => c.type === "interpolation")) return null;
  const match = /^([A-Za-z]*)('''|"""|'|")/.exec(node.text);
  if (!match) return null;
  const [, prefix = "", quote = ""] = match;
  // An f-string with no `{}` is still not read as a literal, as before.
  if (/f/i.test(prefix)) return null;
  const text = node.text;
  if (!text.endsWith(quote) || text.length < prefix.length + quote.length * 2) return null;
  return decodedString(text.slice(prefix.length + quote.length, text.length - quote.length), prefix);
}

const WIDGET_READS = new Set(["get", "getArgument"]);

/** Reads the facts of one Python view. Synchronous: it runs while the tree exists. */
function readFacts(root: SyntaxNode): PythonFacts {
  const bindings = collectBindings(root);
  const memo = new Map<string, Value>();
  const keyOf = (node: SyntaxNode) => `${node.startIndex}:${node.endIndex}:${node.type}`;

  const nameAt = (name: string, at: number, depth: number): Value => {
    const list = (bindings.get(name) ?? []).filter((binding) => binding.how !== "parameter");
    let binding: Binding | undefined;
    for (const candidate of list) if (candidate.at <= at) binding = candidate;
    if (!binding) {
      const fallback = builtin(name);
      if (fallback.kind !== "unknown" || list.length === 0) return fallback;
      binding = list[0];
    }
    if (!binding || binding.how === "other" || binding.how === "parameter") return UNKNOWN;
    if (binding.how === "import") return builtin(binding.imported);
    return resolve(binding.value, depth + 1);
  };

  const resolve = (node: SyntaxNode, depth = 0): Value => {
    // Deep enough for any real alias chain; also stops `a = b`, `b = a`.
    if (depth > 25) return UNKNOWN;
    const key = keyOf(node);
    const known = memo.get(key);
    if (known) return known;
    const value = resolveUncached(node, depth);
    memo.set(key, value);
    return value;
  };

  const resolveUncached = (node: SyntaxNode, depth: number): Value => {
    switch (node.type) {
      case "identifier":
        return nameAt(node.text, node.startIndex, depth);
      case "parenthesized_expression": {
        const inner = namedChildren(node);
        return inner.length === 1 ? resolve(inner[0]!, depth + 1) : UNKNOWN;
      }
      case "call": {
        const callee = child(node, "function");
        const value = callee ? resolve(callee, depth + 1) : UNKNOWN;
        if (value.kind === "factory") return DBUTILS;
        if (value.kind === "clientClass") return { kind: "client" };
        return UNKNOWN;
      }
      case "attribute": {
        const attribute = child(node, "attribute")?.text ?? "";
        // `w.dbutils`, `self.dbutils`, `WorkspaceClient().dbutils`.
        if (attribute === "dbutils") return DBUTILS;
        const object = child(node, "object");
        const owner = object ? resolve(object, depth + 1) : UNKNOWN;
        if (owner.kind === "dbutils") {
          return DBUTILS_MODULES.has(attribute) ? { kind: "module", module: attribute as DbutilsModule | "jobs" } : UNKNOWN;
        }
        if (owner.kind === "module") {
          if (owner.module === "jobs") return attribute === "taskValues" ? { kind: "module", module: "jobs.taskValues" } : UNKNOWN;
          return { kind: "method", module: owner.module, method: attribute };
        }
        if (owner.kind === "client" && attribute === "secrets") return { kind: "sdkSecrets" };
        if (owner.kind === "sdkSecrets") return { kind: "sdkMethod", method: attribute };
        return UNKNOWN;
      }
      default:
        return UNKNOWN;
    }
  };

  // A bare `getArgument(...)` is the notebook's own, unless the file binds the name itself.
  const getArgumentShadowed = (bindings.get("getArgument") ?? []).length > 0;

  /** For `<unknown>.widgets.get(...)`: the module the call's shape names, though its receiver is unknown. */
  const shapeModule = (callee: SyntaxNode): DbutilsModule | undefined => {
    if (callee.type !== "attribute") return undefined;
    const object = child(callee, "object");
    if (object?.type !== "attribute") return undefined;
    const name = child(object, "attribute")?.text;
    if (name === "widgets" || name === "secrets" || name === "notebook") return name;
    const owner = child(object, "object");
    if (name === "taskValues" && owner?.type === "attribute" && child(owner, "attribute")?.text === "jobs") return "jobs.taskValues";
    return undefined;
  };

  const calls: Array<PythonCallFact & { node: SyntaxNode; argNodes: Array<SyntaxNode | null> }> = [];
  const callNodes = root.descendantsOfType("call").filter((node): node is SyntaxNode => node !== null);
  for (const node of callNodes) {
    const callee = child(node, "function");
    if (!callee) continue;
    const value = resolve(callee);
    let fact: { module: PythonCallFact["module"]; method: string; known: boolean } | undefined;
    if (value.kind === "method") fact = { module: value.module, method: value.method, known: true };
    else if (value.kind === "sdkMethod" && value.method === "get_secret") fact = { module: "sdk.secrets", method: "get_secret", known: true };
    else if (callee.type === "identifier" && callee.text === "getArgument" && !getArgumentShadowed) {
      // Reads a widget like dbutils.widgets.getArgument (live, serverless job, 2026-11-25).
      fact = { module: "widgets", method: "getArgument", known: true };
    } else {
      const module = shapeModule(callee);
      const method = child(callee, "attribute")?.text;
      if (module && method) fact = { module, method, known: false };
    }
    if (!fact) continue;
    const argumentList = child(node, "arguments");
    const argNodes: Array<SyntaxNode | null> = [];
    const args: PythonArgumentFact[] = [];
    for (const arg of argumentList?.type === "argument_list" ? namedChildren(argumentList) : argumentList ? [argumentList] : []) {
      if (arg.type === "comment") continue;
      if (arg.type === "keyword_argument") {
        const valueNode = child(arg, "value");
        args.push({ keyword: child(arg, "name")?.text ?? "", value: literalOf(valueNode), isNone: valueNode?.type === "none" });
        argNodes.push(valueNode);
      } else if (arg.type === "list_splat" || arg.type === "dictionary_splat") {
        args.push({ value: null, isNone: false, splat: true });
        argNodes.push(null);
      } else {
        args.push({ value: literalOf(arg), isNone: arg.type === "none" });
        argNodes.push(arg);
      }
    }
    calls.push({ ...fact, args, start: node.startIndex, end: node.endIndex, node, argNodes });
  }

  // #535: the widget an argument's value comes from, when the file shows it plainly.
  const widgetReadAt = new Map<string, string | undefined>();
  for (const call of calls) {
    if (call.module !== "widgets" || !call.known || !WIDGET_READS.has(call.method)) continue;
    widgetReadAt.set(keyOf(call.node), argumentFact(call.args, "name", 0)?.value ?? undefined);
  }
  const widgetReadOf = (node: SyntaxNode | null): string | undefined => {
    if (!node) return undefined;
    if (node.type === "call") return widgetReadAt.get(keyOf(node));
    if (node.type !== "identifier") return undefined;
    const list = bindings.get(node.text) ?? [];
    if (list.length !== 1 || list[0]!.how !== "assign") return undefined;
    const value = list[0]!.value;
    return value.type === "call" ? widgetReadAt.get(keyOf(value)) : undefined;
  };
  for (const call of calls) {
    call.args.forEach((arg, index) => {
      const read = widgetReadOf(call.argNodes[index] ?? null);
      if (read) arg.widgetRead = read;
    });
  }

  return {
    calls: calls.map(({ node: _node, argNodes: _argNodes, ...fact }) => fact),
    passesWidgets: passesWidgets(root, resolve),
  };
}

/** Where a value goes when its parent is one of these: into other code. */
const HANDED_ON = new Set(["argument_list", "keyword_argument", "return_statement", "list", "tuple", "set", "pair", "yield"]);

function passesWidgets(root: SyntaxNode, resolve: (node: SyntaxNode) => Value): boolean {
  const candidates = root.descendantsOfType(["identifier", "attribute", "call"]).filter((node): node is SyntaxNode => node !== null);
  return candidates.some((node) => {
    const parent = node.parent;
    if (!parent || !HANDED_ON.has(parent.type)) return false;
    // `f(name=value)`: the value, not the keyword.
    if (parent.type === "keyword_argument" && child(parent, "value")?.id !== node.id) return false;
    if (parent.type === "pair" && child(parent, "value")?.id !== node.id) return false;
    const value = resolve(node);
    return value.kind === "dbutils" || (value.kind === "module" && value.module === "widgets") || (value.kind === "method" && value.module === "widgets");
  });
}

/**
 * The last views read, by text. Each file's checks start together (see enrichGraph), so the
 * read is kept while it runs: the other checks wait for it instead of each parsing the whole
 * file again (#716). Larger than the number of files checked at once (FILE_SCAN_LIMIT), so a
 * read still running is never dropped.
 */
const cache = new Map<string, Promise<PythonFacts>>();
const CACHE_SIZE = 32;

/** The facts of a Python view (see {@link notebookViews}): offsets are the view's, which are the document's. */
export function pythonFacts(text: string): Promise<PythonFacts> {
  const cached = cache.get(text);
  if (cached) return cached;
  const facts = text.trim() === "" ? Promise.resolve({ calls: [], passesWidgets: false }) : withPythonTree(text, readFacts);
  cache.set(text, facts);
  // A failed read isn't kept, so the next check tries again. The callers still get the error.
  facts.catch(() => {
    if (cache.get(text) === facts) cache.delete(text);
  });
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return facts;
}

/**
 * Reads a pipeline's SQL source text, without running anything, and says which datasets it
 * defines and which tables each one reads (issue 398). Never guesses: a statement or a name
 * it cannot read is reported as such, with its line.
 *
 * Syntax from the Databricks pipeline SQL reference (checked 2026-11-11):
 * https://docs.databricks.com/aws/en/ldp/developer/sql-ref
 * Comments (nested block comments allowed) and common table expressions follow the
 * Databricks SQL language manual.
 */

export type PipelineDatasetKind = "streaming_table" | "materialized_view" | "view" | "table";

/**
 * The catalog and schema a `USE` statement set for what follows it in the same file.
 * `null` means a USE changed it to something the inspector cannot know (such as the default
 * schema of a new catalog). Absent when no USE came before.
 */
export interface SqlNamespace {
  catalog?: string | null;
  schema?: string | null;
}

export interface PipelineDataset {
  /**
   * As written, without a `LIVE.` prefix. Parts are joined with "."; a part that itself
   * contains a dot keeps its backticks, so `` `a.b` `` and `a.b` stay different names.
   */
  name: string;
  kind: PipelineDatasetKind;
  line: number;
  /** `PRIVATE` or `TEMPORARY`: only inside this pipeline. */
  pipelineOnly: boolean;
  namespace?: SqlNamespace;
}

export interface PipelineRead {
  /** The table read, written as dataset names are, or `files:<path>` for a file source. */
  source: string;
  /** The dataset this read feeds. */
  target: string;
  line: number;
  streaming: boolean;
  /** Through a flow (`CREATE FLOW`, `AUTO CDC`, `APPLY CHANGES`) rather than the dataset's own query. */
  flow?: string;
  /** The USE context of the statement, for both its source and its target. */
  namespace?: SqlNamespace;
}

export interface PipelineFlowTarget {
  name: string;
  namespace?: SqlNamespace;
}

export interface PipelineUnread {
  line: number;
  /** For a read that could not be read: the dataset it would feed. */
  target?: string;
  /** What could not be read, in words for the panel. */
  reason: string;
  text: string;
}

export interface PipelineSqlResult {
  datasets: PipelineDataset[];
  reads: PipelineRead[];
  /** Datasets written by a flow, which may have no CREATE in this file. */
  flowTargets: PipelineFlowTarget[];
  unread: PipelineUnread[];
  /** Statements that are not pipeline definitions (SET, USE, comments-only cells…), counted only. */
  ignored: number;
}

interface Token {
  kind: "word" | "punct" | "string";
  /** A word as written, without backticks; strings without quotes. */
  text: string;
  /** For keyword comparisons. Empty for a word that had backticks: a quoted word is never a keyword. */
  upper: string;
  /** A word's name parts, split at dots outside backticks. */
  parts?: string[];
  line: number;
}

const isWordStart = (c: string) => /[A-Za-z0-9_`$]/.test(c);

/** A word may carry dots, backticks and `${…}` placeholders: `a.b.c`, `` `my table`.x ``, `${env}_x`. */
function tokenize(sql: string): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let line = 1;
  let i = 0;
  const end = () => { if (current.length) statements.push(current); current = []; };
  const readString = (quote: string, raw: boolean): string => {
    let text = "";
    i++;
    while (i < sql.length) {
      // A raw string (r'…') keeps its backslashes.
      if (!raw && sql[i] === "\\") { text += sql[i + 1] ?? ""; i += 2; continue; }
      if (sql[i] === quote) { if (sql[i + 1] === quote) { text += quote; i += 2; continue; } i++; break; }
      if (sql[i] === "\n") line++;
      text += sql[i]; i++;
    }
    return text;
  };
  while (i < sql.length) {
    const start = i;
    const c = sql[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      const lineEnd = sql.indexOf("\n", i);
      const comment = sql.slice(i, lineEnd < 0 ? sql.length : lineEnd);
      // A Databricks SQL notebook separates cells with this line; cells often have no ";".
      if (/^-- COMMAND -+\s*$/.test(comment)) end();
      i = lineEnd < 0 ? sql.length : lineEnd;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      // Databricks SQL allows nested block comments: /* a /* b */ c */ is one comment.
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; if (depth === 0) break; continue; }
        if (sql[i] === "\n") line++;
        i++;
      }
      continue;
    }
    if (c === ";") { end(); i++; continue; }
    const rawPrefix = (c === "r" || c === "R") && (sql[i + 1] === "'" || sql[i + 1] === '"') && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "");
    if (rawPrefix || c === "'" || c === '"') {
      const at = line;
      if (rawPrefix) i++;
      const text = readString(sql[i]!, rawPrefix);
      current.push({ kind: "string", text, upper: text.toUpperCase(), line: at });
      continue;
    }
    if (isWordStart(c)) {
      const at = line;
      const parts: string[] = [""];
      let quoted = false;
      while (i < sql.length) {
        const d = sql[i]!;
        if (d === "`") {
          quoted = true;
          i++;
          while (i < sql.length && sql[i] !== "`") { parts[parts.length - 1] += sql[i]!; i++; }
          i++;
          continue;
        }
        if (d === "$") {
          const close = sql[i + 1] === "{" ? sql.indexOf("}", i) : -1;
          if (close >= 0) { parts[parts.length - 1] += sql.slice(i, close + 1); i = close + 1; continue; }
          // An unfinished `${…` (kept with what follows it) or a lone `$`: keep it in the word
          // so the name reads as unreadable, and always move on.
          if (sql[i + 1] === "{") {
            let j = i + 2;
            while (j < sql.length && /[A-Za-z0-9_.]/.test(sql[j]!)) j++;
            parts[parts.length - 1] += sql.slice(i, j); i = j;
            continue;
          }
          parts[parts.length - 1] += d; i++;
          continue;
        }
        if (/[A-Za-z0-9_]/.test(d)) { parts[parts.length - 1] += d; i++; continue; }
        if (d === "." && isWordStart(sql[i + 1] ?? "")) { parts.push(""); i++; continue; }
        break;
      }
      const text = parts.map((part) => (part.includes(".") ? `\`${part}\`` : part)).join(".");
      current.push({ kind: "word", text, upper: quoted ? "" : text.toUpperCase(), parts, line: at });
      if (i === start) i++;
      continue;
    }
    current.push({ kind: "punct", text: c, upper: c, line });
    i++;
  }
  end();
  return statements.flatMap(splitAtStatementStarts);
}

/**
 * Databricks' own examples, and real files, often leave out the ";" between statements. A
 * CREATE, APPLY CHANGES or USE word outside any brackets starts a new one: none can sit
 * inside a query. (APPLY AS DELETE WHEN, inside AUTO CDC, is not followed by CHANGES. A
 * 'CREATE' string or a `create` in backticks is not a keyword.)
 */
function splitAtStatementStarts(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let part: Token[] = [];
  let depth = 0;
  tokens.forEach((token, k) => {
    const starts = depth === 0 && part.length > 0 && token.kind === "word" &&
      (token.upper === "CREATE" || token.upper === "USE" || (token.upper === "APPLY" && tokens[k + 1]?.upper === "CHANGES"));
    if (starts) { parts.push(part); part = []; }
    if (token.kind === "punct" && token.text === "(") depth++;
    else if (token.kind === "punct" && token.text === ")") depth = Math.max(0, depth - 1);
    part.push(token);
  });
  if (part.length) parts.push(part);
  return parts;
}

/** A name's parts, without a `LIVE.` prefix: the docs say the LIVE schema is ignored. */
function nameParts(token: Token): string[] {
  const parts = token.parts ?? [token.text];
  return parts.length > 1 && parts[0]!.toLowerCase() === "live" && token.upper.startsWith("LIVE.") ? parts.slice(1) : parts;
}
const joinParts = (parts: string[]) => parts.map((part) => (part.includes(".") ? `\`${part}\`` : part)).join(".");

const CLAUSE_END = new Set([
  "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "QUALIFY",
  "ON", "USING", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "SEMI", "ANTI", "OUTER",
  "LATERAL", "PIVOT", "UNPIVOT", "TABLESAMPLE", "WATERMARK", "SELECT", "FROM", "KEYS", "SEQUENCE",
  "APPLY", "IGNORE", "STORED", "COLUMNS", "TRACK", "AS", "WITH",
]);
const isPunct = (token: Token | undefined, text: string) => token?.kind === "punct" && token.text === text;

/** The index of the ")" that closes the "(" at `open`, or the end. */
function closeOf(tokens: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (isPunct(tokens[k], "(")) depth++;
    else if (isPunct(tokens[k], ")")) { depth--; if (depth === 0) return k; }
  }
  return tokens.length;
}

/**
 * read_files' path argument starting at `k`: a string, or concat()/|| of strings only.
 * Anything else (a column, a function of a setting) is built in code: `undefined`.
 */
function literalPath(tokens: Token[], k: number): string | undefined {
  let depth = 0;
  let path = "";
  for (let j = k; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (depth === 0 && (isPunct(t, ",") || isPunct(t, ")"))) return path || undefined;
    if (isPunct(t, "(")) { depth++; continue; }
    if (isPunct(t, ")")) { depth--; continue; }
    if (t.kind === "string") { path += t.text; continue; }
    if (isPunct(t, "|") || isPunct(t, ",")) continue;
    if (t.kind === "word" && t.upper === "CONCAT" && isPunct(tokens[j + 1], "(")) continue;
    return undefined;
  }
  return path || undefined;
}

interface FoundRead { name: string; line: number; streaming: boolean }

/** Reads in a query: the table after each FROM and JOIN, skipping names a WITH defines. */
function readsIn(tokens: Token[], from: number, unread: PipelineUnread[]): FoundRead[] {
  // The "(" each token sits inside.
  const opener: number[] = [];
  const stack: number[] = [];
  for (let k = 0; k < tokens.length; k++) {
    opener[k] = stack.length ? stack[stack.length - 1]! : -1;
    if (isPunct(tokens[k], "(")) stack.push(k);
    else if (isPunct(tokens[k], ")")) stack.pop();
  }

  // Common table expressions: `name [(col, …)] AS (query)` after WITH or a comma. A CTE's
  // name hides a table only after its own definition, and only inside the query its WITH
  // belongs to: `FROM orders … (WITH orders AS (…) …)` still reads the real orders first.
  const ctes: { name: string; defined: number; scopeEnd: number }[] = [];
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "word" || !t.upper || CLAUSE_END.has(t.upper)) continue;
    const before = tokens[k - 1];
    if (!(before?.upper === "WITH" || (before?.upper === "RECURSIVE" && tokens[k - 2]?.upper === "WITH") || isPunct(before, ","))) continue;
    let j = k + 1;
    if (isPunct(tokens[j], "(")) j = closeOf(tokens, j) + 1;
    if (tokens[j]?.upper !== "AS" || !isPunct(tokens[j + 1], "(")) continue;
    // A comma only counts when it continues a WITH list at this level.
    if (isPunct(before, ",") && !ctes.some((cte) => cte.scopeEnd > k)) continue;
    const scopeOpen = opener[k]!;
    ctes.push({
      name: t.text.toLowerCase(),
      defined: closeOf(tokens, j + 1),
      scopeEnd: scopeOpen < 0 ? tokens.length : closeOf(tokens, scopeOpen),
    });
  }
  const isCte = (name: string, at: number) =>
    ctes.some((cte) => cte.name === name.toLowerCase() && at > cte.defined && at < cte.scopeEnd);

  const reads: FoundRead[] = [];
  const take = (k: number): number => {
    let t = tokens[k];
    if (!t) return k;
    let streaming = false;
    if (t.kind === "word" && t.upper === "STREAM") {
      streaming = true;
      if (isPunct(tokens[k + 1], "(")) {
        const inner = tokens[k + 2];
        if (inner?.kind === "word" && isPunct(tokens[k + 3], ")")) {
          if (!isCte(inner.text, k + 2)) reads.push({ name: joinParts(nameParts(inner)), line: inner.line, streaming });
          return k + 4;
        }
        // STREAM(read_files(...)) or STREAM(<query>): look inside.
        k += 2; t = tokens[k];
        if (!t) return k;
      } else {
        k++; t = tokens[k];
        if (!t) return k;
      }
    }
    if (t.kind !== "word") return k; // "(" opens a subquery; its own FROM is found later
    if (isPunct(tokens[k + 1], "(") && t.upper) {
      const fn = t.upper;
      // AUTO CDC … FROM SNAPSHOT (SELECT …): the query inside is read like any subquery.
      // The snapshot version helpers pick which snapshot to load; they read no table.
      if (["SNAPSHOT", "CURRENT_SNAPSHOT_VERSION", "LAST_SNAPSHOT_VERSION", "LIST_FILES"].includes(fn)) return k + 1;
      if (fn === "READ_FILES" || fn === "CLOUD_FILES") {
        const path = literalPath(tokens, k + 2);
        if (path === undefined) unread.push({ line: t.line, reason: `reads files from a path built in code`, text: t.text });
        else reads.push({ name: `files:${path}`, line: t.line, streaming });
      } else if (!["VALUES", "RANGE", "EXPLODE"].includes(fn)) {
        unread.push({ line: t.line, reason: `reads from the function ${t.text}(…)`, text: t.text });
      }
      return k + 1;
    }
    if (t.upper && CLAUSE_END.has(t.upper)) return k;
    // Spark reads files directly with FROM parquet.`/path`, json.`dbfs:/…`, delta.`s3://…`.
    const parts = t.parts ?? [t.text];
    if (parts.length === 2 && /^(parquet|json|csv|orc|avro|text|delta|binaryfile)$/i.test(parts[0]!) && /^(\/|[a-z][a-z0-9+.-]*:)/i.test(parts[1]!)) {
      reads.push({ name: `files:${parts[1]}`, line: t.line, streaming });
      return k + 1;
    }
    if (!isCte(t.text, k)) reads.push({ name: joinParts(nameParts(t)), line: t.line, streaming });
    return k + 1;
  };

  // A FROM inside a function's brackets, as in EXTRACT(YEAR FROM d) or TRIM(BOTH ' ' FROM s),
  // is not a read: only a FROM at the top of the query, or in a subquery starting with SELECT
  // or WITH (or bracketed again, as in ((SELECT …))), is.
  const inQuery = (k: number): boolean => {
    let open = opener[k]!;
    while (open >= from) {
      const first = tokens[open + 1];
      if (first?.upper === "SELECT" || first?.upper === "WITH") return true;
      if (!isPunct(first, "(")) return false;
      open = opener[open]!;
      if (open < from) return true;
    }
    return true;
  };
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "word" || (t.upper !== "FROM" && t.upper !== "JOIN")) continue;
    if (!inQuery(k)) continue;
    // DELETE FROM, "IS DISTINCT FROM": keywords that are not reads.
    if (t.upper === "FROM" && (tokens[k - 1]?.upper === "DISTINCT" || tokens[k - 1]?.upper === "DELETE")) continue;
    take(k + 1);
    if (t.upper !== "FROM") continue;
    // FROM a, b and FROM a JOIN b ON …, c: a comma at the FROM's own level, before the next
    // clause (WHERE, GROUP BY …), starts another table. Commas inside brackets do not.
    const level = opener[k];
    for (let j = k + 1; j < tokens.length; j++) {
      const u = tokens[j]!;
      if (opener[j] !== level) continue;
      if (isPunct(u, ")")) break;
      if (u.kind === "word" && ["WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "QUALIFY", "SELECT", "KEYS", "SEQUENCE"].includes(u.upper)) break;
      if (isPunct(u, ",")) take(j + 1);
    }
  }
  return reads;
}

/** `${key}` filled from the configuration; `undefined` when a key is missing or unfinished. */
function placeholderFree(name: string, config: Record<string, string>): string | undefined {
  if (!name.includes("$")) return name;
  let unresolved = false;
  const filled = name.replace(/\$\{([^}]*)\}/g, (_, key: string) => {
    const value = config[key.trim()];
    if (value === undefined) { unresolved = true; return ""; }
    return value;
  });
  // A `$` left over is an unfinished `${…` or a lone `$`: not a name the inspector can read.
  return unresolved || filled.includes("$") ? undefined : filled;
}

/**
 * Reads one SQL source file of a pipeline.
 *
 * @param config The pipeline's `configuration` from the bundle, to fill `${key}` in names.
 */
export function readPipelineSql(sql: string, config: Record<string, string> = {}): PipelineSqlResult {
  const result: PipelineSqlResult = { datasets: [], reads: [], flowTargets: [], unread: [], ignored: 0 };
  let namespace: SqlNamespace | undefined;
  const withNamespace = () => (namespace ? { namespace: { ...namespace } } : {});
  const nameOrUnread = (token: Token | undefined, what: string): string | undefined => {
    if (!token || token.kind !== "word") {
      result.unread.push({ line: token?.line ?? 0, reason: `a ${what} with no name the inspector can read`, text: token?.text ?? "" });
      return undefined;
    }
    const filled = placeholderFree(joinParts(nameParts(token)), config);
    if (filled === undefined) {
      result.unread.push({ line: token.line, reason: `a ${what} named by a setting: ${token.text}`, text: token.text });
      return undefined;
    }
    return filled;
  };
  const addReads = (tokens: Token[], from: number, target: string, flow?: string) => {
    const before = result.unread.length;
    const found = readsIn(tokens, from, result.unread);
    for (const item of result.unread.slice(before)) item.target = target;
    for (const read of found) {
      // A file path fills its ${key} too when the configuration gives it, and is shown as
      // written when not: it is a label for the files, not a table to match.
      const source = read.name.startsWith("files:")
        ? `files:${placeholderFree(read.name.slice("files:".length), config) ?? read.name.slice("files:".length)}`
        : placeholderFree(read.name, config);
      if (source === undefined) {
        result.unread.push({ line: read.line, reason: `a read named by a setting: ${read.name}`, text: read.name, target });
        continue;
      }
      result.reads.push({ source, target, line: read.line, streaming: read.streaming, ...(flow ? { flow } : {}), ...withNamespace() });
    }
  };
  const addFlowTarget = (name: string) => result.flowTargets.push({ name, ...withNamespace() });

  for (const tokens of tokenize(sql)) {
    const w = (k: number) => tokens[k]?.upper ?? "";
    if (w(0) === "USE") {
      // USE CATALOG c, USE SCHEMA [c.]s, USE DATABASE s, USE [c.]s: later names in this file
      // are read against it. A new catalog's default schema is not known.
      const kind = w(1);
      const token = ["CATALOG", "SCHEMA", "DATABASE"].includes(kind) ? tokens[2] : tokens[1];
      const parts = token?.kind === "word" ? nameParts(token) : [];
      if (kind === "CATALOG" && parts.length === 1) namespace = { catalog: parts[0]!, schema: null };
      else if (parts.length === 2) namespace = { catalog: parts[0]!, schema: parts[1]! };
      else if (parts.length === 1) namespace = { ...(namespace ?? {}), schema: parts[0]! };
      else namespace = { catalog: null, schema: null };
      result.ignored++;
      continue;
    }
    if (w(0) === "APPLY" && w(1) === "CHANGES" && w(2) === "INTO") {
      // Legacy AUTO CDC: APPLY CHANGES INTO target FROM source …
      const target = nameOrUnread(tokens[3], "change target");
      if (target) { addFlowTarget(target); addReads(tokens, 4, target, "apply changes"); }
      continue;
    }
    if (w(0) !== "CREATE") { result.ignored++; continue; }
    let k = 1;
    if (w(k) === "OR" && (w(k + 1) === "REFRESH" || w(k + 1) === "REPLACE")) k += 2;
    if (w(k) === "FLOW") {
      const flowName = tokens[k + 1]?.text ?? "";
      let j = k + 2;
      while (j < tokens.length && w(j) !== "AS") j++;
      j++;
      let target: string | undefined;
      if (w(j) === "INSERT") {
        j++; if (w(j) === "ONCE") j++;
        if (w(j) === "INTO") j++;
        target = nameOrUnread(tokens[j], "flow target");
      } else if (w(j) === "AUTO" && w(j + 1) === "CDC") {
        j += 2; if (w(j) === "ONCE") j++;
        if (w(j) === "INTO") j++;
        target = nameOrUnread(tokens[j], "change target");
      } else if (w(j) === "APPLY" && w(j + 1) === "CHANGES" && w(j + 2) === "INTO") {
        j += 3;
        target = nameOrUnread(tokens[j], "change target");
      } else {
        result.unread.push({ line: tokens[0]!.line, reason: "a flow the inspector does not understand", text: tokens.slice(0, 6).map((t) => t.text).join(" ") });
        continue;
      }
      if (target) { addFlowTarget(target); addReads(tokens, j + 1, target, flowName); }
      continue;
    }
    let pipelineOnly = false;
    let streaming = false;
    let materialized = false;
    let live = false;
    for (;;) {
      if (w(k) === "PRIVATE" || w(k) === "TEMPORARY" || w(k) === "TEMP") { pipelineOnly = true; k++; continue; }
      if (w(k) === "STREAMING") { streaming = true; k++; continue; }
      if (w(k) === "MATERIALIZED") { materialized = true; k++; continue; }
      if (w(k) === "LIVE") { live = true; k++; continue; }
      break;
    }
    let kind: PipelineDatasetKind;
    if (w(k) === "TABLE") kind = streaming ? "streaming_table" : live ? "materialized_view" : "table";
    else if (w(k) === "VIEW") kind = materialized ? "materialized_view" : "view";
    else {
      // CREATE FUNCTION, CREATE SINK… are not datasets the view draws.
      result.unread.push({ line: tokens[0]!.line, reason: `a CREATE ${tokens[k]?.text ?? ""} statement the view does not draw`, text: tokens.slice(0, k + 2).map((t) => t.text).join(" ") });
      continue;
    }
    k++;
    if (w(k) === "IF" && w(k + 1) === "NOT" && w(k + 2) === "EXISTS") k += 3;
    const name = nameOrUnread(tokens[k], kind === "view" ? "view" : "table");
    if (!name) continue;
    result.datasets.push({ name, kind, line: tokens[k]!.line, pipelineOnly, ...withNamespace() });
    addReads(tokens, k + 1, name);
  }
  return result;
}

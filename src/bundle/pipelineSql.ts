/**
 * Reads a pipeline's SQL source text, without running anything, and says which datasets it
 * defines and which tables each one reads (issue 398). Never guesses: a statement or a name
 * it cannot read is reported as such, with its line.
 *
 * Syntax from the Databricks pipeline SQL reference (checked 2026-11-11):
 * https://docs.databricks.com/aws/en/ldp/developer/sql-ref
 */

export type PipelineDatasetKind = "streaming_table" | "materialized_view" | "view" | "table";

export interface PipelineDataset {
  /** As written, without backticks or a `LIVE.` prefix. */
  name: string;
  kind: PipelineDatasetKind;
  line: number;
  /** `PRIVATE` or `TEMPORARY`: only inside this pipeline. */
  pipelineOnly: boolean;
}

export interface PipelineRead {
  /** The table read, as written (without backticks or `LIVE.`), or `files:<path>` for read_files. */
  source: string;
  /** The dataset this read feeds. */
  target: string;
  line: number;
  streaming: boolean;
  /** Through a flow (`CREATE FLOW`, `AUTO CDC`, `APPLY CHANGES`) rather than the dataset's own query. */
  flow?: string;
}

export interface PipelineUnread {
  line: number;
  /** What could not be read, in words for the panel. */
  reason: string;
  text: string;
}

export interface PipelineSqlResult {
  datasets: PipelineDataset[];
  reads: PipelineRead[];
  /** Datasets written by a flow, with no CREATE in this file (they may be created in another). */
  flowTargets: string[];
  unread: PipelineUnread[];
  /** Statements that are not pipeline definitions (SET, USE, comments-only cells…), counted only. */
  ignored: number;
}

interface Token {
  kind: "word" | "punct" | "string";
  /** Words keep their text; `upper` is for keyword comparisons. */
  text: string;
  upper: string;
  line: number;
}

/** A word may carry dots, backticks and `${…}` placeholders: `a.b.c`, `` `my table`.x ``, `${env}_x`. */
function tokenize(sql: string): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let line = 1;
  let i = 0;
  const push = (kind: Token["kind"], text: string, at: number) =>
    current.push({ kind, text, upper: text.toUpperCase(), line: at });
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const comment = sql.slice(i, end < 0 ? sql.length : end);
      // A Databricks SQL notebook separates cells with this line; cells often have no ";".
      if (/^-- COMMAND -+\s*$/.test(comment)) { if (current.length) statements.push(current); current = []; }
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) { if (sql[i] === "\n") line++; i++; }
      i += 2;
      continue;
    }
    if (c === ";") { if (current.length) statements.push(current); current = []; i++; continue; }
    if (c === "'" || c === '"') {
      const start = line; let text = ""; i++;
      while (i < sql.length) {
        if (sql[i] === "\\") { text += sql[i + 1] ?? ""; i += 2; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { text += c; i += 2; continue; } i++; break; }
        if (sql[i] === "\n") line++;
        text += sql[i]; i++;
      }
      push("string", text, start);
      continue;
    }
    if (/[A-Za-z0-9_`$]/.test(c)) {
      const start = line; let text = "";
      while (i < sql.length) {
        const d = sql[i]!;
        if (d === "`") { i++; while (i < sql.length && sql[i] !== "`") { text += sql[i]; i++; } i++; continue; }
        if (d === "$" && sql[i + 1] === "{") { const end = sql.indexOf("}", i); if (end < 0) break; text += sql.slice(i, end + 1); i = end + 1; continue; }
        if (/[A-Za-z0-9_]/.test(d) || (d === "." && /[A-Za-z0-9_`$]/.test(sql[i + 1] ?? ""))) { text += d; i++; continue; }
        break;
      }
      push("word", text, start);
      continue;
    }
    push("punct", c, line);
    i++;
  }
  if (current.length) statements.push(current);
  return statements;
}

/** `LIVE.x` and `live.x` name `x` in the pipeline; the docs say the LIVE schema is ignored. */
function cleanName(name: string): string {
  return name.replace(/^live\./i, "");
}

const CLAUSE_END = new Set([
  "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "QUALIFY",
  "ON", "USING", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "SEMI", "ANTI", "OUTER",
  "LATERAL", "PIVOT", "UNPIVOT", "TABLESAMPLE", "WATERMARK", "SELECT", "FROM", "KEYS", "SEQUENCE",
  "APPLY", "IGNORE", "STORED", "COLUMNS", "TRACK", "AS", "WITH",
]);

/** Reads in a query: the table after each FROM and JOIN, skipping names defined by WITH. */
function readsIn(tokens: Token[], from: number, unread: PipelineUnread[]): { name: string; line: number; streaming: boolean }[] {
  const ctes = new Set<string>();
  for (let k = from; k < tokens.length - 2; k++) {
    if (tokens[k]!.kind === "word" && tokens[k + 1]!.upper === "AS" && tokens[k + 2]!.text === "(" &&
        (tokens[k - 1]?.upper === "WITH" || tokens[k - 1]?.text === ",")) ctes.add(tokens[k]!.text.toLowerCase());
  }
  const reads: { name: string; line: number; streaming: boolean }[] = [];
  const take = (k: number): number => {
    let t = tokens[k];
    if (!t) return k;
    let streaming = false;
    if (t.upper === "STREAM") {
      streaming = true;
      if (tokens[k + 1]?.text === "(") {
        const inner = tokens[k + 2];
        if (inner?.kind === "word" && tokens[k + 3]?.text === ")") {
          reads.push({ name: cleanName(inner.text), line: inner.line, streaming });
          return k + 4;
        }
        // STREAM(read_files(...)) or STREAM(<query>): look inside.
        return take(k + 2);
      }
      k++; t = tokens[k];
      if (!t) return k;
    }
    if (t.kind !== "word") return k; // "(" opens a subquery; its own FROM is found later
    const next = tokens[k + 1];
    if (next?.text === "(") {
      const fn = t.upper;
      if (fn === "READ_FILES" || fn === "CLOUD_FILES") {
        const path = tokens[k + 2]?.kind === "string" ? tokens[k + 2]!.text : "";
        reads.push({ name: `files:${path}`, line: t.line, streaming });
      } else if (!["VALUES", "RANGE", "EXPLODE"].includes(fn)) {
        unread.push({ line: t.line, reason: `reads from the function ${t.text}(…)`, text: t.text });
      }
      return k + 1;
    }
    if (CLAUSE_END.has(t.upper)) return k;
    // Spark reads files directly with FROM parquet.`/path`, json.`dbfs:/…`, delta.`s3://…`.
    const direct = /^(parquet|json|csv|orc|avro|text|delta|binaryfile)\.(.+)$/i.exec(t.text);
    if (direct && /^(\/|[a-z][a-z0-9+.-]*:)/i.test(direct[2]!)) {
      reads.push({ name: `files:${direct[2]}`, line: t.line, streaming });
      return k + 1;
    }
    const name = cleanName(t.text);
    if (!ctes.has(name.toLowerCase())) reads.push({ name, line: t.line, streaming });
    return k + 1;
  };
  // The "(" each token sits inside. A FROM inside a function's brackets, as in
  // EXTRACT(YEAR FROM d) or TRIM(BOTH ' ' FROM s), is not a read: only a FROM at the top
  // of the query, or inside a subquery that starts with SELECT or WITH, is.
  const opener: number[] = [];
  const stack: number[] = [];
  for (let k = 0; k < tokens.length; k++) {
    opener[k] = stack.length ? stack[stack.length - 1]! : -1;
    if (tokens[k]!.text === "(") stack.push(k);
    else if (tokens[k]!.text === ")") stack.pop();
  }
  const inQuery = (k: number): boolean => {
    const open = opener[k]!;
    if (open < from) return true;
    const first = tokens[open + 1]?.upper;
    return first === "SELECT" || first === "WITH";
  };
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "word" || (t.upper !== "FROM" && t.upper !== "JOIN")) continue;
    if (!inQuery(k)) continue;
    // DELETE FROM, "IS DISTINCT FROM", "EXCEPT (… FROM …)" style keywords that are not reads.
    if (t.upper === "FROM" && (tokens[k - 1]?.upper === "DISTINCT" || tokens[k - 1]?.upper === "DELETE")) continue;
    take(k + 1);
    if (t.upper !== "FROM") continue;
    // FROM a, b and FROM a JOIN b ON …, c: a comma at the FROM's own level, before the next
    // clause (WHERE, GROUP BY …), starts another table. Commas inside brackets do not.
    const level = opener[k];
    for (let j = k + 1; j < tokens.length; j++) {
      const u = tokens[j]!;
      if (opener[j] !== level) continue;
      if (u.text === ")") break;
      if (u.kind === "word" && ["WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "QUALIFY", "SELECT", "KEYS", "SEQUENCE"].includes(u.upper)) break;
      if (u.text === ",") take(j + 1);
    }
  }
  return reads;
}

function placeholderFree(name: string, config: Record<string, string>): string | undefined {
  if (!name.includes("${")) return name;
  let unresolved = false;
  const filled = name.replace(/\$\{([^}]*)\}/g, (_, key: string) => {
    const value = config[key.trim()];
    if (value === undefined) { unresolved = true; return ""; }
    return value;
  });
  return unresolved ? undefined : filled;
}

/**
 * Reads one SQL source file of a pipeline.
 *
 * @param config The pipeline's `configuration` from the bundle, to fill `${key}` in names.
 */
export function readPipelineSql(sql: string, config: Record<string, string> = {}): PipelineSqlResult {
  const result: PipelineSqlResult = { datasets: [], reads: [], flowTargets: [], unread: [], ignored: 0 };
  const nameOrUnread = (token: Token | undefined, what: string): string | undefined => {
    if (!token || token.kind !== "word") {
      result.unread.push({ line: token?.line ?? 0, reason: `a ${what} with no name the inspector can read`, text: token?.text ?? "" });
      return undefined;
    }
    const filled = placeholderFree(cleanName(token.text), config);
    if (filled === undefined) {
      result.unread.push({ line: token.line, reason: `a ${what} named by a setting: ${token.text}`, text: token.text });
      return undefined;
    }
    return filled;
  };
  const addReads = (tokens: Token[], from: number, target: string, flow?: string) => {
    for (const read of readsIn(tokens, from, result.unread)) {
      const source = read.name.startsWith("files:") ? read.name : placeholderFree(read.name, config);
      if (source === undefined) {
        result.unread.push({ line: read.line, reason: `a read named by a setting: ${read.name}`, text: read.name });
        continue;
      }
      result.reads.push({ source, target, line: read.line, streaming: read.streaming, ...(flow ? { flow } : {}) });
    }
  };

  for (const tokens of tokenize(sql)) {
    const w = (k: number) => tokens[k]?.upper ?? "";
    if (w(0) === "APPLY" && w(1) === "CHANGES" && w(2) === "INTO") {
      // Legacy AUTO CDC: APPLY CHANGES INTO target FROM source …
      const target = nameOrUnread(tokens[3], "change target");
      if (target) { result.flowTargets.push(target); addReads(tokens, 4, target, "apply changes"); }
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
      if (target) { result.flowTargets.push(target); addReads(tokens, j + 1, target, flowName); }
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
    result.datasets.push({ name, kind, line: tokens[k]!.line, pipelineOnly });
    addReads(tokens, k + 1, name);
  }
  return result;
}

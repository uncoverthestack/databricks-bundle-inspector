/**
 * Runs the command-line tool built from the base and from the pull request on the same real
 * bundles, and compares their findings (#651).
 *
 *   node out/corpus/run.cjs --base <base cli.cjs> --head <head cli.cjs> [--summary <file>] [--allow-changes] <folder>...
 *
 * Exits 1 when the findings differ, unless --allow-changes. Only `bundle validate` runs, with
 * the bundles' own scripts and Python turned off; no sign-in.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compareReports, comparisonMarkdown, hasChanges, type CorpusReport } from "./compareFindings.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    head: { type: "string" },
    summary: { type: "string" },
    "allow-changes": { type: "boolean", default: false },
  },
});
if (!values.base || !values.head || positionals.length === 0) {
  throw new Error("Usage: run.cjs --base <cli.cjs> --head <cli.cjs> [--summary <file>] [--allow-changes] <folder>...");
}

function check(cli: string, folder: string): CorpusReport {
  try {
    const output = execFileSync(process.execPath, [cli, "check", folder, "--format", "json", "--fail-on", "never", "--no-color"], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION: "1" },
    });
    return JSON.parse(output) as CorpusReport;
  } catch (error) {
    const status = (error as { status?: number }).status;
    // 2: no bundle under the folder.
    if (status === 2) return { bundles: [] };
    throw new Error(`${cli} on ${folder} exited with ${status}: ${String((error as { stderr?: string }).stderr ?? error)}`);
  }
}

const all = (cli: string): CorpusReport => ({ bundles: positionals.flatMap((folder) => check(cli, folder).bundles) });
const started = Date.now();
const comparison = compareReports(all(values.base), all(values.head));
const markdown = comparisonMarkdown(comparison, `${positionals.length} folders, ${Math.round((Date.now() - started) / 1000)} s`);
process.stdout.write(markdown);
if (values.summary) appendFileSync(values.summary, markdown);
if (hasChanges(comparison) && !values["allow-changes"]) process.exitCode = 1;

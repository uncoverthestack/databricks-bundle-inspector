import { afterAll, describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../bundle/issues.js";
import { locateFix } from "../../bundle/quickFix.js";
import { validateBundle } from "../../bundle/validateBundle.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The issue's line after its fix is applied, or undefined when no fix is offered. */
function fixedLine(issue: InspectorIssue): string | undefined {
  if (!issue.fix || !issue.file || !issue.line) return undefined;
  const line = readFileSync(issue.file, "utf8").split(/\r?\n/)[issue.line - 1]!;
  const span = locateFix(line, issue.fix.oldText, issue.column);
  return span ? line.slice(0, span.start) + issue.fix.newText + line.slice(span.end) : undefined;
}

/**
 * The fix is built from what the file says at the finding's line and column, not from
 * the CLI's value: with a real target the CLI reports paths from the bundle root
 * (`src/etl`), while a resource file holds them from its own folder (`../src/etl`).
 */
describe(`the missing-extension fix edits the path as written (${cli})`, () => {
  test("with the inspector's probe target: in a resource file, a pipeline, and databricks.yml, but not through a variable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-quick-fix-"));
    created.push(dir);
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "resources"));
    await writeFile(path.join(dir, "src", "etl.py"), "# Databricks notebook source\nprint(1)\n");
    await writeFile(
      path.join(dir, "databricks.yml"),
      [
        "bundle:",
        "  name: quick-fix",
        "include:",
        "  - resources/*.yml",
        "variables:",
        "  nb_dir:",
        "    default: ../src",
        "resources:",
        "  jobs:",
        "    root_job:",
        "      tasks:",
        "        - task_key: at_root",
        '          notebook_task: { notebook_path: "./src/etl" }',
        "        - task_key: at_root_block",
        "          notebook_task:",
        '            notebook_path: "./src/etl"',
        "targets:",
        "  dev:",
        "    default: true",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(dir, "resources", "job.yml"),
      [
        "resources:",
        "  jobs:",
        "    nightly:",
        "      tasks:",
        "        - task_key: plain",
        "          notebook_task:",
        "            notebook_path: ../src/etl",
        "        - task_key: through_variable",
        "          notebook_task:",
        "            notebook_path: ${var.nb_dir}/etl",
        "  pipelines:",
        "    bronze:",
        "      libraries:",
        "        - notebook:",
        "            path: ../src/etl  # the bronze notebook",
        "",
      ].join("\n"),
    );

    const result = await validateBundle(dir, undefined, cli);
    if (!result.ok) throw new Error(result.error.details ?? result.error.error);
    const cliPath = (result.data.resources?.jobs?.nightly?.tasks?.[0] as any)?.notebook_task?.notebook_path;
    // The probe target reports paths as written. If this fails, the CLI changed how it reports them.
    expect(cliPath).toBe("../src/etl");

    const graph = await enrichGraphWithFileContent(await extractBundleGraph(result.data, dir));
    const issues = buildInspectorIssues(graph, result.data, result.issues ?? [], dir);
    const missing = (end: string) => issues.find((issue) => issue.kind === "missing_file" && issue.yamlPath?.endsWith(end));

    const plain = missing("tasks.plain.notebook_task.notebook_path");
    expect(plain?.fix).toEqual({ oldText: "../src/etl", newText: "../src/etl.py", title: 'Change to "../src/etl.py"' });
    expect(fixedLine(plain!)).toBe("            notebook_path: ../src/etl.py");

    const pipeline = issues.find((issue) => issue.resourceId === "resources.pipelines.bronze" && issue.kind === "missing_file");
    expect(fixedLine(pipeline!)).toBe("            path: ../src/etl.py  # the bronze notebook");

    const atRoot = missing("tasks.at_root.notebook_task.notebook_path");
    expect(fixedLine(atRoot!)).toBe('          notebook_task: { notebook_path: "./src/etl.py" }');
    const atRootBlock = missing("tasks.at_root_block.notebook_task.notebook_path");
    expect(fixedLine(atRootBlock!)).toBe('            notebook_path: "./src/etl.py"');

    // A path built from a variable is not one value the fix could edit.
    expect(missing("tasks.through_variable.notebook_task.notebook_path")?.fix).toBeUndefined();
    expect(issues.filter((issue) => issue.fix)).toHaveLength(4);
  });
});

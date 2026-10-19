import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { validateBundle } from "../../bundle/validateBundle.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * The structural preview leaves variables in paths unresolved, so the file behind them is
 * never checked. Each such path must get a path_not_checked note at its line, and nothing
 * else may: "not checked" must never look like "no problems".
 */
describe(`a path that uses a variable says it wasn't checked (${cli})`, () => {
  test("every form gets one note at its line; literal, remote and non-path values get none", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-path-not-checked-"));
    created.push(dir);
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "resources"));
    await writeFile(path.join(dir, "src", "load.py"), '# Databricks notebook source\nx = dbutils.widgets.get("run_date")\n');
    await writeFile(path.join(dir, "src", "job.py"), "print(1)\n");
    await writeFile(
      path.join(dir, "databricks.yml"),
      [
        "bundle:",
        "  name: path-not-checked",
        "include:",
        "  - resources/*.yml",
        "variables:",
        "  nb_dir:",
        "    default: ./src",
        "  nb_path:",
        "    default: ./src/load.py",
        "  up_dir:",
        "    default: ../src",
        "  ws_dir:",
        "    default: /Workspace/Shared",
        "resources:",
        "  jobs:",
        "    root_job:",
        "      tasks:",
        "        - task_key: in_folder",
        "          notebook_task:",
        '            notebook_path: "${var.nb_dir}/load.py"',
        "        - task_key: whole_path",
        "          notebook_task:",
        '            notebook_path: "${var.nb_path}"',
        "        - task_key: file_path",
        "          notebook_task:",
        '            notebook_path: "${workspace.file_path}/src/load.py"',
        "        - task_key: literal",
        "          notebook_task:",
        "            notebook_path: ./src/load.py",
        "            base_parameters:",
        '              run_date: "${var.nb_dir}"',
        "        - task_key: remote",
        "          notebook_task:",
        '            notebook_path: "/Workspace/${var.nb_dir}/load"',
        "        - task_key: python",
        "          spark_python_task:",
        '            python_file: "${var.nb_dir}/job.py"',
        "        - task_key: loop",
        "          for_each_task:",
        '            inputs: "[1, 2]"',
        "            task:",
        "              task_key: loop_inner",
        "              notebook_task:",
        '                notebook_path: "${var.nb_dir}/load.py"',
        "targets:",
        "  dev:",
        "    default: true",
        "    variables:",
        "      nb_dir: ./other",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(dir, "resources", "job.yml"),
      [
        "resources:",
        "  jobs:",
        "    included_job:",
        "      tasks:",
        "        - task_key: from_resource",
        "          notebook_task:",
        '            notebook_path: "${var.up_dir}/load.py"',
        "  pipelines:",
        "    bronze:",
        "      libraries:",
        "        - notebook:",
        '            path: "${var.up_dir}/load.py"',
        "        - file:",
        '            path: "${var.up_dir}/job.py"',
        "        - glob:",
        '            include: "${var.up_dir}/**"',
        "",
      ].join("\n"),
    );

    const result = await validateBundle(dir, undefined, cli);
    if (!result.ok) throw new Error(result.error.details ?? result.error.error);
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(result.data, dir));
    const issues = buildInspectorIssues(graph, result.data, result.issues ?? [], dir);
    const notes = issues
      .filter((issue) => issue.kind === "path_not_checked")
      .map((issue) => ({ file: path.relative(dir, issue.file ?? ""), line: issue.line, severity: issue.severity }))
      .sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));

    expect(notes).toEqual([
      { file: "databricks.yml", line: 20, severity: "info" }, // ${var.nb_dir}/load.py
      { file: "databricks.yml", line: 23, severity: "info" }, // ${var.nb_path}
      { file: "databricks.yml", line: 26, severity: "info" }, // ${workspace.file_path}/src/load.py
      { file: "databricks.yml", line: 37, severity: "info" }, // python_file
      { file: "databricks.yml", line: 44, severity: "info" }, // for_each inner task
      { file: "resources/job.yml", line: 7, severity: "info" }, // task in an included file
      { file: "resources/job.yml", line: 12, severity: "info" }, // pipeline notebook
      { file: "resources/job.yml", line: 14, severity: "info" }, // pipeline file
      { file: "resources/job.yml", line: 16, severity: "info" }, // pipeline glob
    ]);
    // The structural preview wording points at the target picker.
    expect(issues.find((issue) => issue.kind === "path_not_checked" && issue.line === 20)?.title).toBe(
      'Not checked: "${var.nb_dir}/load.py" uses a variable, so the file is only known once a target is resolved. Pick a target in the graph to check it.',
    );
    // The literal path is checked as usual: its notebook reads a widget the task passes.
    expect(issues.some((issue) => issue.taskName === "literal" && issue.kind === "missing_file")).toBe(false);
  });
});

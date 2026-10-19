import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { validateBundle } from "../../bundle/validateBundle.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
/** A ~/.databrickscfg profile: a real target only rewrites paths when the CLI can log in. */
const profile = process.env.INSPECTOR_TEST_PROFILE?.trim() || undefined;
const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * With a login, a fully resolved real target gives workspace paths (`/Workspace/.../files/src/load`),
 * which the inspector can't read. It maps them back to the local files, so its checks still run.
 */
describe(`a real target's workspace paths are read as local files (${cli})`, () => {
  (profile ? test : test.skip)("the notebook is found and its widget is checked", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-real-paths-"));
    created.push(dir);
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "resources"));
    await writeFile(
      path.join(dir, "src", "load.py"),
      '# Databricks notebook source\nrun_date = dbutils.widgets.get("run_date")\n',
    );
    await writeFile(
      path.join(dir, "databricks.yml"),
      "bundle:\n  name: real-paths\ninclude:\n  - resources/*.yml\ntargets:\n  dev:\n    default: true\n",
    );
    await writeFile(
      path.join(dir, "resources", "job.yml"),
      [
        "resources:",
        "  jobs:",
        "    nightly:",
        "      tasks:",
        "        - task_key: load",
        "          notebook_task:",
        "            notebook_path: ../src/load.py",
        "",
      ].join("\n"),
    );

    const result = await validateBundle(dir, "dev", cli, profile);
    if (!result.ok) throw new Error(result.error.details ?? result.error.error);
    const cliPath = (result.data.resources?.jobs?.nightly?.tasks?.[0] as any)?.notebook_task?.notebook_path;
    // If this fails, the CLI stopped rewriting paths and the rest proves nothing.
    expect(cliPath).toMatch(/^\/Workspace\/.*\/files\/src\/load$/);

    const graph = await enrichGraphWithFileContent(await extractBundleGraph(result.data, dir));
    const task = graph.nodes.find((node) => node.nodeType === "task");
    expect(task?.taskData?.fileReferences[0]).toMatchObject({ path: "../src/load.py", exists: true });
    const issues = buildInspectorIssues(graph, result.data, result.issues ?? [], dir, "dev");
    expect(issues.map((issue) => issue.kind)).toContain("widget_parameter_mismatch");
  });
});

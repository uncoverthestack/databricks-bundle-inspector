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

  /** Writes a bundle under `parent/proj` and returns the graph path of its only task, resolved. */
  async function mappedNotebook(databricksYml: string, files: Record<string, string>): Promise<string | undefined> {
    const parent = await mkdtemp(path.join(os.tmpdir(), "dbi-real-paths-"));
    created.push(parent);
    const dir = path.join(parent, "proj");
    for (const [relative, content] of Object.entries({ ...files, "databricks.yml": databricksYml })) {
      await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      await writeFile(path.join(dir, relative), content);
    }
    const result = await validateBundle(dir, "dev", cli, profile);
    if (!result.ok) throw new Error(result.error.details ?? result.error.error);
    const graph = await extractBundleGraph(result.data, dir);
    const ref = graph.nodes.find((node) => node.nodeType === "task")?.taskData?.fileReferences[0];
    return ref?.exists && ref.resolvedPath ? path.relative(dir, ref.resolvedPath) : undefined;
  }
  const NOTEBOOK = "# Databricks notebook source\nprint(1)\n";

  (profile ? test : test.skip)("files uploaded from the parent folder, with a folder named like the bundle inside it", async () => {
    // sync.paths [".."] makes the CLI upload the parent, so the path comes back as ./files/proj/src/nb.
    // proj/proj/src/nb.py exists too, and must not be taken for it.
    const yml = "bundle: {name: shadow}\nsync: {paths: [\"..\"]}\ntargets:\n  dev: {default: true}\nresources:\n  jobs:\n    j:\n      tasks:\n        - task_key: t\n          notebook_task: {notebook_path: ./src/nb.py}\n";
    expect(await mappedNotebook(yml, { "src/nb.py": NOTEBOOK, "proj/src/nb.py": NOTEBOOK })).toBe(path.join("src", "nb.py"));
  });

  (profile ? test : test.skip)("a path built from a variable", async () => {
    const yml = "bundle: {name: varpath}\nvariables:\n  nb_dir: {default: ./src}\ntargets:\n  dev:\n    default: true\n    variables: {nb_dir: ./other}\nresources:\n  jobs:\n    j:\n      tasks:\n        - task_key: t\n          notebook_task: {notebook_path: \"${var.nb_dir}/nb.py\"}\n";
    expect(await mappedNotebook(yml, { "src/nb.py": NOTEBOOK, "other/nb.py": NOTEBOOK })).toBe(path.join("other", "nb.py"));
  });
});

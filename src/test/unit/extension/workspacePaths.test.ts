import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { localizeWorkspacePaths, type SourceDocument } from "../../../bundle/workspacePaths.js";

// Shapes follow real `bundle validate -o json` output for a fully resolved target (CLI
// 1.21.0, checked against a workspace): local paths become paths under
// workspace.file_path, relative to the sync root, and notebooks lose their extension.
const FILES = "/Workspace/Users/someone@example.com/.bundle/demo/dev/files";

let parent: string;
let bundleRoot: string;
let resourcesDir: string;

async function touch(relative: string, content = ""): Promise<void> {
  const file = path.join(bundleRoot, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

const job = (tasks: unknown[]) => ({ resources: { jobs: { j: { tasks } } } });
const notebookTask = (key: string, notebookPath: string) => ({
  task_key: key,
  notebook_task: { notebook_path: notebookPath },
});

/** CLI output for a real target, given its resources. */
function output(resources: unknown, extra: Record<string, unknown> = {}): ParsedBundleConfig {
  return {
    bundle: { name: "demo", target: "dev" },
    workspace: { file_path: FILES },
    ...(resources as object),
    ...extra,
  } as unknown as ParsedBundleConfig;
}

/** The bundle's YAML as written, in `resources/job.yml`. */
const writtenInResources = (resources: unknown): SourceDocument[] => [
  { file: path.join(resourcesDir, "job.yml"), doc: resources },
];
const dirOf = () => resourcesDir;
const notebookPathOf = (config: ParsedBundleConfig, index = 0) =>
  (config as any).resources.jobs.j.tasks[index].notebook_task.notebook_path;

beforeEach(async () => {
  parent = await mkdtemp(path.join(tmpdir(), "bdi-ws-paths-"));
  bundleRoot = path.join(parent, "proj");
  resourcesDir = path.join(bundleRoot, "resources");
  await mkdir(resourcesDir, { recursive: true });
  await touch("src/nb.py", "# Databricks notebook source\n");
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe("localizeWorkspacePaths: normal cases", () => {
  test("maps every field the inspector reads back to the file as written", async () => {
    await touch("src/inner.py", "# Databricks notebook source\n");
    await touch("src/script.py");
    await touch("src/query.sql");
    await touch("dbt/dbt_project.yml");
    await touch("pipelines/nb.sql", "-- Databricks notebook source\n");
    await touch("pipelines/p1.py");
    await touch("pipelines/glob/g.py");
    const resources = (paths: Record<string, string>) => ({
      resources: {
        jobs: {
          j: {
            tasks: [
              notebookTask("notebook", paths.nb!),
              { task_key: "python", spark_python_task: { python_file: paths.py } },
              { task_key: "sql", sql_task: { file: { path: paths.sql } } },
              { task_key: "dbt", dbt_task: { project_directory: paths.dbt } },
              { task_key: "loop", for_each_task: { task: notebookTask("inner", paths.inner!) } },
            ],
          },
        },
        pipelines: {
          p: {
            libraries: [
              { notebook: { path: paths.pnb } },
              { file: { path: paths.pfile } },
              { glob: { include: paths.glob } },
            ],
          },
        },
      },
    });
    const written = resources({
      nb: "../src/nb.py", py: "../src/script.py", sql: "../src/query.sql", dbt: "../dbt",
      inner: "../src/inner.py", pnb: "../pipelines/nb.sql", pfile: "../pipelines/p1.py", glob: "../pipelines/glob/**",
    });
    const cli = resources({
      nb: `${FILES}/src/nb`, py: `${FILES}/src/script.py`, sql: `${FILES}/src/query.sql`, dbt: `${FILES}/dbt`,
      inner: `${FILES}/src/inner`, pnb: `${FILES}/pipelines/nb`, pfile: `${FILES}/pipelines/p1.py`, glob: `${FILES}/pipelines/glob/**`,
    });

    const out = localizeWorkspacePaths(output(cli), writtenInResources(written), dirOf);

    expect((out as any).resources).toEqual(written.resources);
  });

  test("a resource defined in the bundle folder gets ./ paths", () => {
    const sources = [{ file: path.join(bundleRoot, "databricks.yml"), doc: job([notebookTask("t", "./src/nb.py")]) }];
    const out = localizeWorkspacePaths(output(job([notebookTask("t", `${FILES}/src/nb`)])), sources, () => bundleRoot);
    expect(notebookPathOf(out)).toBe("./src/nb.py");
  });

  test("leaves other values alone, such as a parameter that names a workspace file", () => {
    const cli = job([{ ...notebookTask("t", `${FILES}/src/nb`), notebook_task: { notebook_path: `${FILES}/src/nb`, base_parameters: { conf: `${FILES}/conf.yml` } } }]);
    const out = localizeWorkspacePaths(output(cli), writtenInResources(job([notebookTask("t", "../src/nb.py")])), dirOf) as any;
    expect(out.resources.jobs.j.tasks[0].notebook_task.base_parameters.conf).toBe(`${FILES}/conf.yml`);
  });

  test("leaves the structural preview and partial runs alone (no rewritten paths)", () => {
    const preview = output(job([notebookTask("t", "../src/nb.py")]));
    expect(localizeWorkspacePaths(preview, writtenInResources(job([notebookTask("t", "../src/nb.py")])), dirOf)).toBe(preview);
    const templated = output(job([notebookTask("t", "../src/nb.py")]), { workspace: { file_path: "${workspace.root_path}/files" } });
    expect(localizeWorkspacePaths(templated, [], dirOf)).toBe(templated);
  });

  test("does not change the CLI output it was given", () => {
    const cli = output(job([notebookTask("t", `${FILES}/src/nb`)]));
    const before = JSON.stringify(cli);
    localizeWorkspacePaths(cli, writtenInResources(job([notebookTask("t", "../src/nb.py")])), dirOf);
    expect(JSON.stringify(cli)).toBe(before);
  });
});

describe("localizeWorkspacePaths: where the files were uploaded from", () => {
  test("a parent folder (sync.paths outside the bundle)", () => {
    const out = localizeWorkspacePaths(
      output(job([notebookTask("t", `${FILES}/proj/src/nb`)])),
      writtenInResources(job([notebookTask("t", "../src/nb.py")])),
      dirOf,
    );
    expect(notebookPathOf(out)).toBe("../src/nb.py");
  });

  test("a bundle folder that contains a folder with its own name is not mistaken for the upload folder", async () => {
    // proj/proj/src/nb.py exists too; the upload folder is the parent, so the file is proj/src/nb.py.
    await touch("proj/src/nb.py", "# Databricks notebook source\n");
    const out = localizeWorkspacePaths(
      output(job([notebookTask("t", `${FILES}/proj/src/nb`)])),
      writtenInResources(job([notebookTask("t", "../src/nb.py")])),
      dirOf,
    );
    expect(path.resolve(resourcesDir, notebookPathOf(out))).toBe(path.join(bundleRoot, "src", "nb.py"));
  });

  test("anchors that disagree on the upload folder map nothing", async () => {
    await touch("x/b.py", "# Databricks notebook source\n");
    const cli = output(job([notebookTask("a", `${FILES}/src/nb`), notebookTask("b", `${FILES}/proj/x/b`)]));
    const written = writtenInResources(job([notebookTask("a", "../src/nb.py"), notebookTask("b", "../x/b.py")]));
    expect(localizeWorkspacePaths(cli, written, dirOf)).toBe(cli);
  });

  test("no anchor (every path is a workspace substitution) maps nothing", () => {
    const cli = output(job([notebookTask("t", `${FILES}/src/nb.py`)]));
    const written = writtenInResources(job([notebookTask("t", "${workspace.file_path}/src/nb.py")]));
    expect(localizeWorkspacePaths(cli, written, dirOf)).toBe(cli);
  });

  test("one literal path anchors the others, including a workspace substitution", async () => {
    await touch("src/b.py", "# Databricks notebook source\n");
    const cli = output(job([notebookTask("a", `${FILES}/src/nb`), notebookTask("b", `${FILES}/src/b.py`)]));
    const written = writtenInResources(job([notebookTask("a", "../src/nb.py"), notebookTask("b", "${workspace.file_path}/src/b.py")]));
    const out = localizeWorkspacePaths(cli, written, dirOf);
    expect([notebookPathOf(out, 0), notebookPathOf(out, 1)]).toEqual(["../src/nb.py", "../src/b.py"]);
  });
});

describe("localizeWorkspacePaths: how a path was written", () => {
  test("a variable, filled in from the CLI's final value", () => {
    const cli = output(job([notebookTask("t", `${FILES}/src/nb`)]), { variables: { nb_dir: { value: "../src" } } });
    const out = localizeWorkspacePaths(cli, writtenInResources(job([notebookTask("t", "${var.nb_dir}/nb.py")])), dirOf);
    expect(notebookPathOf(out)).toBe("../src/nb.py");
  });

  test("${bundle.target}, filled in from the CLI output", async () => {
    await touch("src/dev/nb.py", "# Databricks notebook source\n");
    const out = localizeWorkspacePaths(
      output(job([notebookTask("t", `${FILES}/src/dev/nb`)])),
      writtenInResources(job([notebookTask("t", "../src/${bundle.target}/nb.py")])),
      dirOf,
    );
    expect(notebookPathOf(out)).toBe("../src/dev/nb.py");
  });

  test("a path the selected target overrides uses the target's value", async () => {
    await touch("src/b.py", "# Databricks notebook source\n");
    const sources: SourceDocument[] = [
      { file: path.join(bundleRoot, "databricks.yml"), doc: { ...job([notebookTask("t", "./src/nb.py")]), targets: { dev: job([notebookTask("t", "./src/b.py")]) } } },
    ];
    const out = localizeWorkspacePaths(output(job([notebookTask("t", `${FILES}/src/b`)])), sources, () => bundleRoot);
    expect(notebookPathOf(out)).toBe("./src/b.py");
  });

  test("the written notebook decides when nb.py and nb.sql both exist", async () => {
    await touch("src/nb.sql", "-- Databricks notebook source\n");
    const out = localizeWorkspacePaths(
      output(job([notebookTask("t", `${FILES}/src/nb`)])),
      writtenInResources(job([notebookTask("t", "../src/nb.sql")])),
      dirOf,
    );
    expect(notebookPathOf(out)).toBe("../src/nb.sql");
  });

  test("without its own anchor, an ambiguous notebook stays as the CLI gave it; the others are mapped", async () => {
    await touch("src/other.py", "# Databricks notebook source\n");
    await touch("src/other.sql", "-- Databricks notebook source\n");
    const cli = output(job([notebookTask("a", `${FILES}/src/nb`), notebookTask("b", `${FILES}/src/other`)]));
    const written = writtenInResources(job([notebookTask("a", "../src/nb.py"), notebookTask("b", "${workspace.file_path}/src/other")]));
    const out = localizeWorkspacePaths(cli, written, dirOf);
    expect([notebookPathOf(out, 0), notebookPathOf(out, 1)]).toEqual(["../src/nb.py", `${FILES}/src/other`]);
  });

  test("a dbt project written as the upload folder itself", async () => {
    await touch("dbt_project.yml");
    const dbt = (dir: string) => job([{ task_key: "dbt", dbt_task: { project_directory: dir } }]);
    const sources = [{ file: path.join(bundleRoot, "databricks.yml"), doc: dbt(".") }];
    const out = localizeWorkspacePaths(output(dbt(FILES)), sources, () => bundleRoot) as any;
    expect(out.resources.jobs.j.tasks[0].dbt_task.project_directory).toBe(".");
  });
});

describe("extractBundleGraph reads real target paths through YAML merge keys", () => {
  test("a job built from a YAML anchor (<<: *job) is still an anchor", async () => {
    await writeFile(
      path.join(bundleRoot, "databricks.yml"),
      ["bundle: {name: demo}", "base: &job", "  tasks:", "    - task_key: t", "      notebook_task: {notebook_path: ./src/nb.py}", "resources:", "  jobs:", "    j:", "      <<: *job", ""].join("\n"),
    );
    const graph = await extractBundleGraph(output(job([notebookTask("t", `${FILES}/src/nb`)])), bundleRoot);
    const task = graph.nodes.find((node) => node.nodeType === "task");
    expect(task?.taskData?.fileReferences[0]).toMatchObject({ path: "./src/nb.py", exists: true });
  });
});

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { localizeWorkspacePaths } from "../../../bundle/workspacePaths.js";

// The shape of `bundle validate -o json` for a fully resolved real target (CLI 1.21.0):
// local paths become paths under workspace.file_path, and notebooks lose their extension.
const FILES = "/Workspace/Users/someone@example.com/.bundle/demo/dev/files";

let parent: string;
let bundleRoot: string;
let resourcesDir: string;

async function touch(relative: string, content = ""): Promise<void> {
  const file = path.join(bundleRoot, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

function realTargetOutput(): ParsedBundleConfig {
  return {
    bundle: { name: "demo" },
    workspace: { file_path: FILES },
    resources: {
      jobs: {
        j: {
          tasks: [
            {
              task_key: "notebook",
              notebook_task: {
                notebook_path: `${FILES}/src/nb`,
                base_parameters: { conf: `${FILES}/conf/app.yml` },
              },
            },
            { task_key: "python", spark_python_task: { python_file: `${FILES}/src/script.py` } },
            { task_key: "sql", sql_task: { file: { path: `${FILES}/src/query.sql` } } },
            { task_key: "dbt", dbt_task: { project_directory: `${FILES}/dbt` } },
            {
              task_key: "loop",
              for_each_task: { task: { task_key: "inner", notebook_task: { notebook_path: `${FILES}/src/nb` } } },
            },
          ],
        },
      },
      pipelines: {
        p: {
          libraries: [
            { notebook: { path: `${FILES}/pipelines/nb` } },
            { file: { path: `${FILES}/pipelines/p1.py` } },
            { glob: { include: `${FILES}/pipelines/**` } },
          ],
        },
      },
    },
  } as unknown as ParsedBundleConfig;
}

const dirOf = () => resourcesDir;

beforeEach(async () => {
  parent = await mkdtemp(path.join(tmpdir(), "bdi-ws-paths-"));
  bundleRoot = path.join(parent, "bundle");
  resourcesDir = path.join(bundleRoot, "resources");
  await mkdir(resourcesDir, { recursive: true });
  await touch("src/nb.py", "# Databricks notebook source\n");
  await touch("src/script.py");
  await touch("src/query.sql");
  await touch("dbt/dbt_project.yml");
  await touch("pipelines/nb.sql", "-- Databricks notebook source\n");
  await touch("pipelines/p1.py");
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe("localizeWorkspacePaths", () => {
  test("maps every rewritten path back to its local file, relative to the resource's YAML folder", () => {
    const out = localizeWorkspacePaths(realTargetOutput(), bundleRoot, dirOf) as any;
    const tasks = out.resources.jobs.j.tasks;

    // A notebook gets its extension back, as found on disk.
    expect(tasks[0].notebook_task.notebook_path).toBe("../src/nb.py");
    expect(tasks[1].spark_python_task.python_file).toBe("../src/script.py");
    expect(tasks[2].sql_task.file.path).toBe("../src/query.sql");
    expect(tasks[3].dbt_task.project_directory).toBe("../dbt");
    expect(tasks[4].for_each_task.task.notebook_task.notebook_path).toBe("../src/nb.py");
    const libraries = out.resources.pipelines.p.libraries;
    expect(libraries[0].notebook.path).toBe("../pipelines/nb.sql");
    expect(libraries[1].file.path).toBe("../pipelines/p1.py");
    expect(libraries[2].glob.include).toBe("../pipelines/**");
  });

  test("a resource defined in the bundle folder gets ./ paths", () => {
    const out = localizeWorkspacePaths(realTargetOutput(), bundleRoot, () => bundleRoot) as any;
    expect(out.resources.jobs.j.tasks[0].notebook_task.notebook_path).toBe("./src/nb.py");
  });

  test("leaves other values alone, such as a parameter that names a workspace file", () => {
    const out = localizeWorkspacePaths(realTargetOutput(), bundleRoot, dirOf) as any;
    expect(out.resources.jobs.j.tasks[0].notebook_task.base_parameters.conf).toBe(`${FILES}/conf/app.yml`);
  });

  test("files uploaded from a parent folder (sync.paths outside the bundle) are found there", () => {
    const output = realTargetOutput() as any;
    // With sync.paths: [".."] the CLI uploads the parent folder, so paths start with bundle/.
    output.resources.jobs.j.tasks[0].notebook_task.notebook_path = `${FILES}/bundle/src/nb`;
    output.resources.jobs.j.tasks = [output.resources.jobs.j.tasks[0]];
    output.resources.pipelines = {};

    const out = localizeWorkspacePaths(output, bundleRoot, dirOf) as any;

    expect(out.resources.jobs.j.tasks[0].notebook_task.notebook_path).toBe("../src/nb.py");
  });

  test("maps nothing when one rewritten path can't be found, rather than guess", () => {
    const output = realTargetOutput() as any;
    output.resources.jobs.j.tasks[1].spark_python_task.python_file = `${FILES}/src/not_here.py`;

    expect(localizeWorkspacePaths(output, bundleRoot, dirOf)).toBe(output);
  });

  test("leaves the structural preview alone: no workspace path, or one still a template", () => {
    const preview = {
      bundle: { name: "demo" },
      resources: { jobs: { j: { tasks: [{ task_key: "t", notebook_task: { notebook_path: "./src/nb.py" } }] } } },
    } as unknown as ParsedBundleConfig;
    expect(localizeWorkspacePaths(preview, bundleRoot, dirOf)).toBe(preview);

    const templated = { ...preview, workspace: { file_path: "${workspace.root_path}/files" } } as ParsedBundleConfig;
    expect(localizeWorkspacePaths(templated, bundleRoot, dirOf)).toBe(templated);
  });

  test("does not change the CLI output it was given", () => {
    const output = realTargetOutput();
    const before = JSON.stringify(output);
    localizeWorkspacePaths(output, bundleRoot, dirOf);
    expect(JSON.stringify(output)).toBe(before);
  });
});

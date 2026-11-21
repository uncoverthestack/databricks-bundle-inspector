import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { existsWithCase, withFolderNames } from "../../../bundle/resources/task.js";
import { respellPath, spelledOnDisk } from "../../../bundle/pathCase.js";

const CONFIG = {
  bundle: { name: "b" },
  resources: {
    jobs: {
      j: {
        name: "j",
        tasks: [
          { task_key: "right", notebook_task: { notebook_path: "./notebooks/main.py" } },
          { task_key: "wrong_notebook", notebook_task: { notebook_path: "./Notebooks/Main.py" } },
          { task_key: "wrong_file", spark_python_task: { python_file: "./SRC/job.py" } },
          { task_key: "notebook_as_file", spark_python_task: { python_file: "./NOTEBOOKS/main.py" } },
        ],
      },
    },
  },
} as unknown as ParsedBundleConfig;

// The same answers on a disk that ignores letter case (macOS, Windows) and on one that
// doesn't (Linux): the workspace is case sensitive, so a wrong-case path fails there (#475).
describe("paths with the wrong letter case (#475)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "bdi-case-"));
    mkdirSync(path.join(root, "notebooks"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "notebooks", "main.py"), '# Databricks notebook source\nx = dbutils.widgets.get("w")\n');
    writeFileSync(path.join(root, "src", "job.py"), "print(1)\n");
    // Suggestions are written from the YAML file that holds the path, so the bundle file is real.
    writeFileSync(path.join(root, "databricks.yml"), `${JSON.stringify(CONFIG, null, 2)}\n`);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("existsWithCase compares each name below the anchor with the disk", () => {
    expect(existsWithCase(path.join(root, "notebooks", "main.py"), root)).toBe(true);
    expect(existsWithCase(path.join(root, "Notebooks", "main.py"), root)).toBe(false);
    expect(existsWithCase(path.join(root, "notebooks", "Main.py"), root)).toBe(false);
    expect(existsWithCase(path.join(root, "notebooks", "nope.py"), root)).toBe(false);
    // Outside the anchor nothing is uploaded, so only whether it exists counts.
    expect(existsWithCase(path.join(root, "src", "job.py"), path.join(root, "notebooks"))).toBe(true);
  });

  test("one check reads each folder once; the next one, and any lookup outside a check, sees a rename", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "bdi-case-rename-"));
    // Through a temporary name, as a disk that ignores case may not rename by case alone.
    const renameTo = (from: string, to: string) => {
      renameSync(path.join(folder, from), path.join(folder, "tmp.py"));
      renameSync(path.join(folder, "tmp.py"), path.join(folder, to));
    };
    try {
      writeFileSync(path.join(folder, "load.py"), "print(1)\n");
      await withFolderNames(async () => {
        expect(existsWithCase(path.join(folder, "Load.py"), folder)).toBe(false);
        renameTo("load.py", "Load.py");
      });
      await withFolderNames(async () => {
        expect(existsWithCase(path.join(folder, "Load.py"), folder)).toBe(true);
      });
      renameTo("Load.py", "load.py");
      expect(existsWithCase(path.join(folder, "load.py"), folder)).toBe(true);
      expect(existsWithCase(path.join(folder, "Load.py"), folder)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("a wrong-case path is not found, with the right one suggested, and nothing reads it", async () => {
    const config = CONFIG;
    const graph = await extractBundleGraph(config, root);
    const issues = buildInspectorIssues(graph, config, [], root)
      .filter((issue) => issue.kind !== "widget_not_set")
      .map((issue) => [issue.taskName, issue.kind, issue.detail]);
    expect(issues).toEqual([
      ["wrong_notebook", "missing_file", './Notebooks/Main.py. Did you mean "./notebooks/main.py"?'],
      ["wrong_file", "missing_file", './SRC/job.py. Did you mean "./src/job.py"?'],
      // The only file that matches apart from case is a notebook, which a file task can't take.
      ["notebook_as_file", "missing_file", "./NOTEBOOKS/main.py"],
    ]);
  });
});

// The same answers on every OS (#477): the extension and the disk's letter case together.
describe("a notebook path with the wrong letter case and no extension (#477)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "bdi-case-noext-"));
    mkdirSync(path.join(root, "notebooks"));
    writeFileSync(path.join(root, "notebooks", "main.py"), "# Databricks notebook source\nprint(1)\n");
    writeFileSync(
      path.join(root, "databricks.yml"),
      [
        "bundle: {name: b}",
        "resources:",
        "  jobs:",
        "    j:",
        "      name: j",
        "      tasks:",
        "        - task_key: wrong_case",
        "          notebook_task:",
        "            notebook_path: ./Notebooks/Main",
        "        - task_key: right_case",
        "          notebook_task:",
        "            notebook_path: ./notebooks/main",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("spelledOnDisk finds the disk's names whatever the case, and nothing outside the anchor", () => {
    expect(spelledOnDisk(path.join(root, "Notebooks", "MAIN.py"), root)).toBe(path.join(root, "notebooks", "main.py"));
    expect(spelledOnDisk(path.join(root, "notebooks", "main.py"), root)).toBe(path.join(root, "notebooks", "main.py"));
    expect(spelledOnDisk(path.join(root, "notebooks", "other.py"), root)).toBeUndefined();
    expect(spelledOnDisk(path.join(root, "notebooks", "main.py"), path.join(root, "elsewhere"))).toBeUndefined();
  });

  test("respellPath keeps the leading ./ and ../", () => {
    expect(respellPath("./Notebooks/Main.py", "/b/notebooks/main.py")).toBe("./notebooks/main.py");
    expect(respellPath("../Src/Nb.py", "/b/src/nb.py")).toBe("../src/nb.py");
  });

  test("the suggestion and its quick fix use the disk's letter case", async () => {
    const config = {
      bundle: { name: "b" },
      resources: {
        jobs: {
          j: {
            name: "j",
            tasks: [
              { task_key: "wrong_case", notebook_task: { notebook_path: "./Notebooks/Main" } },
              { task_key: "right_case", notebook_task: { notebook_path: "./notebooks/main" } },
            ],
          },
        },
      },
    } as unknown as ParsedBundleConfig;
    const issues = buildInspectorIssues(await extractBundleGraph(config, root), config, [], root);
    expect(issues.map((issue) => [issue.taskName, issue.kind, issue.title, issue.fix?.newText])).toEqual([
      ["wrong_case", "notebook_missing_extension", 'Notebook "./Notebooks/Main" may not be found. Did you mean "./notebooks/main.py"?', "./notebooks/main.py"],
      ["right_case", "notebook_missing_extension", 'Notebook "./notebooks/main" may not be found. Did you mean "./notebooks/main.py"?', "./notebooks/main.py"],
    ]);
  });
});

describe("a pipeline glob folder with the wrong letter case (#477)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "bdi-case-glob-"));
    mkdirSync(path.join(root, "transformations"));
    writeFileSync(path.join(root, "transformations", "a.sql"), "CREATE OR REFRESH MATERIALIZED VIEW a AS SELECT 1\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("is reported as on Linux, and the right case is fine", async () => {
    const config = {
      bundle: { name: "b" },
      resources: {
        pipelines: {
          p: {
            name: "p",
            libraries: [{ glob: { include: "./Transformations/**" } }, { glob: { include: "./transformations/**" } }],
          },
        },
      },
    } as unknown as ParsedBundleConfig;
    const issues = buildInspectorIssues(await extractBundleGraph(config, root), config, [], root);
    expect(issues.map((issue) => [issue.kind, issue.detail])).toEqual([["missing_pipeline_source", "./Transformations/**"]]);
  });
});


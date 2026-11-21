import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { existsWithCase } from "../../../bundle/resources/task.js";

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

  test("a rename is seen at once, though folder names are cached", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "bdi-case-rename-"));
    try {
      writeFileSync(path.join(folder, "load.py"), "print(1)\n");
      expect(existsWithCase(path.join(folder, "Load.py"), folder)).toBe(false);
      // Through a temporary name, as a disk that ignores case may not rename by case alone.
      renameSync(path.join(folder, "load.py"), path.join(folder, "tmp.py"));
      renameSync(path.join(folder, "tmp.py"), path.join(folder, "Load.py"));
      expect(existsWithCase(path.join(folder, "Load.py"), folder)).toBe(true);
      expect(existsWithCase(path.join(folder, "load.py"), folder)).toBe(false);
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

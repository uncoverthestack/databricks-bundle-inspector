import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// #508: a path to a named pipe passes `bundle validate` (CLI v1.27.0), and reading one
// waits for data that never comes, so the inspection never finished. Only regular files
// are read now. Windows has no mkfifo, so it skips these.
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "named-pipe-"));
  mkdirSync(path.join(root, "transforms"));
  writeFileSync(path.join(root, "main.py"), "# Databricks notebook source\nx = 1\n");
  writeFileSync(path.join(root, "transforms", "orders.sql"), "CREATE MATERIALIZED VIEW orders AS SELECT 1;\n");
  for (const pipe of ["pipe.py", "pipe.sql", "transforms/pipe.sql"]) {
    expect(spawnSync("mkfifo", [path.join(root, pipe)]).status).toBe(0);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Settles within a second or says it didn't: a hung read never settles. */
async function withinASecond<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("still reading after 1 second")), 1000);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

(process.platform === "win32" ? describe.skip : describe)("paths to named pipes", () => {
  test("task files, pipeline files and pipeline folders with a pipe are inspected without reading it", async () => {
    const config = {
      bundle: { name: "pipes" },
      resources: {
        jobs: {
          job: {
            name: "job",
            tasks: [
              { task_key: "notebook", notebook_task: { notebook_path: "./pipe.py" } },
              { task_key: "script", spark_python_task: { python_file: "./pipe.py" } },
              { task_key: "sql", sql_task: { file: { path: "./pipe.sql" }, warehouse_id: "w" } },
              { task_key: "real", notebook_task: { notebook_path: "./main.py" } },
            ],
          },
        },
        pipelines: {
          pipeline: {
            name: "pipeline",
            libraries: [{ file: { path: "./pipe.sql" } }, { glob: { include: "./transforms/**" } }],
          },
        },
      },
    } as unknown as ParsedBundleConfig;

    const graph = await withinASecond(enrichGraphWithFileContent(await extractBundleGraph(config, root)));
    buildInspectorIssues(graph, config, [], root);

    // The real files around the pipes are still read.
    const pipeline = graph.nodes.find((node) => node.id === "resources.pipelines.pipeline");
    expect(pipeline?.pipelineDataFlow).toBeDefined();
    expect(JSON.stringify(pipeline?.pipelineDataFlow)).toContain("orders");
    const tasks = graph.nodes.filter((node) => node.nodeType === "task").map((node) => node.displayName).sort();
    expect(tasks).toEqual(["notebook", "real", "script", "sql"]);
  });
});

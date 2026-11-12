import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../../bundle/issues.js";

// #419. Live tests (Databricks CLI v1.26.0, 2026-11-12): a serverless notebook task with no
// environment in the job ran on the latest version; an .ipynb saved with an environment ran
// on it; a notebook task with an environment_key ran on that environment's version.

const ipynb = (environment?: Record<string, string>) =>
  JSON.stringify({
    cells: [{ cell_type: "code", metadata: {}, outputs: [], source: ["print(1)"] }],
    metadata: {
      "application/vnd.databricks.v1+notebook": { language: "python", ...(environment ? { environmentMetadata: environment } : {}) },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 0,
  });

const YAML = `bundle:
  name: notebook-environment
resources:
  jobs:
    j:
      environments:
        - environment_key: v4
          spec:
            environment_version: "4"
      job_clusters:
        - job_cluster_key: c
          new_cluster:
            spark_version: 15.4.x-scala2.12
      tasks:
        - task_key: source_py
          notebook_task:
            notebook_path: ./nb/source.py
        - task_key: source_sql
          notebook_task:
            notebook_path: ./nb/query.sql
        - task_key: ipynb_none
          notebook_task:
            notebook_path: ./nb/none.ipynb
        - task_key: ipynb_pinned
          notebook_task:
            notebook_path: ./nb/pinned.ipynb
        - task_key: ipynb_base
          notebook_task:
            notebook_path: ./nb/base.ipynb
        - task_key: ipynb_empty_version
          notebook_task:
            notebook_path: ./nb/empty.ipynb
        - task_key: ipynb_broken
          notebook_task:
            notebook_path: ./nb/broken.ipynb
        - task_key: with_environment
          environment_key: v4
          notebook_task:
            notebook_path: ./nb/source.py
        - task_key: on_job_cluster
          job_cluster_key: c
          notebook_task:
            notebook_path: ./nb/source.py
        - task_key: on_existing_cluster
          existing_cluster_id: abc
          notebook_task:
            notebook_path: ./nb/source.py
        - task_key: workspace_path
          notebook_task:
            notebook_path: /Workspace/Shared/nb
        - task_key: missing_file
          notebook_task:
            notebook_path: ./nb/missing.py
        - task_key: script
          spark_python_task:
            python_file: ./nb/source.py
        - task_key: loop
          for_each_task:
            inputs: "[1]"
            task:
              task_key: loop_inner
              notebook_task:
                notebook_path: ./nb/source.py
        - task_key: loop_pinned
          for_each_task:
            inputs: "[1]"
            task:
              task_key: loop_pinned_inner
              environment_key: v4
              notebook_task:
                notebook_path: ./nb/source.py
    single:
      tasks:
        - task_key: only
          notebook_task:
            notebook_path: ./nb/source.py
        - task_key: pinned
          environment_key: e
          notebook_task:
            notebook_path: ./nb/source.py
    from_git:
      git_source:
        git_url: https://github.com/example/repo
        git_provider: gitHub
        git_branch: main
      tasks:
        - task_key: git_nb
          notebook_task:
            notebook_path: nb/source
            source: GIT
`;

let root: string;
let hints: InspectorIssue[];

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "dbi-notebook-env-"));
  mkdirSync(path.join(root, "nb"));
  writeFileSync(path.join(root, "databricks.yml"), YAML);
  writeFileSync(path.join(root, "nb", "source.py"), "# Databricks notebook source\nprint(1)\n");
  writeFileSync(path.join(root, "nb", "query.sql"), "-- Databricks notebook source\nSELECT 1\n");
  writeFileSync(path.join(root, "nb", "none.ipynb"), ipynb());
  writeFileSync(path.join(root, "nb", "pinned.ipynb"), ipynb({ base_environment: "", environment_version: "4" }));
  writeFileSync(path.join(root, "nb", "base.ipynb"), ipynb({ base_environment: "workspace-base-environments/databricks_ml_v5" }));
  writeFileSync(path.join(root, "nb", "empty.ipynb"), ipynb({ base_environment: "", environment_version: "" }));
  writeFileSync(path.join(root, "nb", "broken.ipynb"), "{ not json");
  const config = parse(YAML) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
  hints = buildInspectorIssues(graph, config, [], root).filter((issue) => issue.kind === "notebook_environment_not_set");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("notebook_environment_not_set", () => {
  test("one note per job, naming the notebook tasks Databricks picks the version for, and nothing else", () => {
    expect(hints.map((issue) => [issue.resourceId, issue.title, issue.detail])).toEqual([
      [
        "resources.jobs.j",
        'Job "j" has 5 notebook tasks with no environment version. Databricks may change it.',
        "Tasks: source_py, source_sql, ipynb_none, ipynb_empty_version, loop_inner",
      ],
      ["resources.jobs.single", 'Job "single" has notebook task "only" with no environment version. Databricks may change it.', undefined],
    ]);
  });

  test("is a note on the job's own line in the YAML", () => {
    const hint = hints.find((issue) => issue.resourceId === "resources.jobs.j")!;
    expect(hint.severity).toBe("info");
    expect(hint.taskId).toBeUndefined();
    expect(path.basename(hint.file ?? "")).toBe("databricks.yml");
    expect(YAML.split("\n")[hint.line! - 1]!.trim()).toBe("j:");
  });

  test("the fix names both ways to pin them", () => {
    expect(hints[0]!.fixHint).toBe(
      "To pin them, add a job environment with environment_version and set environment_key on each task, or use an .ipynb notebook saved with an environment.",
    );
    expect(hints[1]!.fixHint).toBe(
      "To pin it, add a job environment with environment_version and set environment_key on the task, or use an .ipynb notebook saved with an environment.",
    );
  });
});

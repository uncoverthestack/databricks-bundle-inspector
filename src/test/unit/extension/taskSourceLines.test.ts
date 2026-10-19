import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBundleGraph } from "../../../bundle/graph/bundleGraph.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// A finding on a task must point at that task's own line. In a real target the CLI
// sorts each job's tasks by task_key (MergeJobTasks), so a task's position in the CLI
// output is not its position in the file. The outputs below are trimmed from real
// `bundle validate -o json` runs (CLI v1.21.0) of the same files.

const JOB_YAML = `resources:
  jobs:
    j:
      name: case-sort-order
      tasks:
        - task_key: z_task
          notebook_task:
            notebook_path: ../src/missing_z.py
        - task_key: a_task
          notebook_task:
            notebook_path: ../src/missing_a.py
`;
const Z_TASK_PATH_LINE = 8;
const A_TASK_PATH_LINE = 11;

/** Structural preview: the CLI stops before merging, so the file's order is kept. */
const PREVIEW_OUTPUT = {
  bundle: { name: "case-sort-order" },
  include: ["resources/job.yml"],
  resources: {
    jobs: {
      j: {
        name: "case-sort-order",
        tasks: [
          { task_key: "z_task", notebook_task: { notebook_path: "../src/missing_z.py" } },
          { task_key: "a_task", notebook_task: { notebook_path: "../src/missing_a.py" } },
        ],
      },
    },
  },
};

/** Real target with a login: tasks sorted by key, paths relative to the bundle root. */
const REAL_TARGET_OUTPUT = {
  bundle: { name: "case-sort-order" },
  include: ["resources/job.yml"],
  resources: {
    jobs: {
      j: {
        name: "case-sort-order",
        tasks: [
          { task_key: "a_task", notebook_task: { notebook_path: "src/missing_a.py" } },
          { task_key: "z_task", notebook_task: { notebook_path: "src/missing_z.py" } },
        ],
      },
    },
  },
};

let bundleRoot: string;

beforeEach(async () => {
  bundleRoot = await mkdtemp(path.join(tmpdir(), "bdi-task-lines-"));
  await mkdir(path.join(bundleRoot, "resources"));
  await writeFile(
    path.join(bundleRoot, "databricks.yml"),
    "bundle:\n  name: case-sort-order\ninclude:\n  - resources/*.yml\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});

async function missingFileLines(output: unknown): Promise<Record<string, number | undefined>> {
  const config = output as ParsedBundleConfig;
  const graph = await extractBundleGraph(config, bundleRoot);
  const issues = buildInspectorIssues(graph, config, [], bundleRoot);
  return Object.fromEntries(
    issues
      .filter((issue) => issue.kind === "missing_file")
      .map((issue) => [issue.taskName ?? "", issue.line]),
  );
}

describe("task findings point at their own task's line", () => {
  test("real target, tasks sorted by the CLI", async () => {
    await writeFile(path.join(bundleRoot, "resources", "job.yml"), JOB_YAML, "utf8");

    expect(await missingFileLines(REAL_TARGET_OUTPUT)).toEqual({
      a_task: A_TASK_PATH_LINE,
      z_task: Z_TASK_PATH_LINE,
    });
  });

  test("structural preview, tasks in the file's order", async () => {
    await writeFile(path.join(bundleRoot, "resources", "job.yml"), JOB_YAML, "utf8");

    expect(await missingFileLines(PREVIEW_OUTPUT)).toEqual({
      a_task: A_TASK_PATH_LINE,
      z_task: Z_TASK_PATH_LINE,
    });
  });

  test("a task that is not in the job's file gets no line, not another task's", async () => {
    // For example a task a target adds: it is written under targets.*, not in this file.
    await writeFile(path.join(bundleRoot, "resources", "job.yml"), JOB_YAML, "utf8");
    const output = structuredClone(REAL_TARGET_OUTPUT);
    output.resources.jobs.j.tasks.unshift({
      task_key: "added_by_target",
      notebook_task: { notebook_path: "src/missing_added.py" },
    });

    expect(await missingFileLines(output)).toEqual({
      added_by_target: undefined,
      a_task: A_TASK_PATH_LINE,
      z_task: Z_TASK_PATH_LINE,
    });
  });

  test("a secret in a task's own cluster points at that task's line", async () => {
    await writeFile(
      path.join(bundleRoot, "resources", "job.yml"),
      `resources:
  jobs:
    j:
      tasks:
        - task_key: z_task
          new_cluster:
            spark_conf:
              zconf: "{{secrets/s/z}}"
        - task_key: a_task
          new_cluster:
            spark_conf:
              aconf: "{{secrets/s/a}}"
`,
      "utf8",
    );
    const output = {
      bundle: { name: "case-sort-order" },
      include: ["resources/job.yml"],
      resources: {
        jobs: {
          j: {
            tasks: [
              { task_key: "a_task", new_cluster: { spark_conf: { aconf: "{{secrets/s/a}}" } } },
              { task_key: "z_task", new_cluster: { spark_conf: { zconf: "{{secrets/s/z}}" } } },
            ],
          },
        },
      },
    } as unknown as ParsedBundleConfig;

    const graph = await extractBundleGraph(output, bundleRoot);
    const secretLines = Object.fromEntries(
      graph.edges
        .filter((edge) => edge.kind === "references" && edge.id.includes("->secret->"))
        .map((edge) => [edge.source, (edge.data as { line?: number } | undefined)?.line]),
    );

    expect(secretLines).toEqual({
      "resources.jobs.j.tasks.z_task": 8,
      "resources.jobs.j.tasks.a_task": 12,
    });
  });
});

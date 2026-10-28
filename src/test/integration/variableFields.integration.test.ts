import { describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { jobReviewReport } from "../../bundle/reviewReport.js";
import { validateBundle } from "../../bundle/validateBundle.js";
import { buildPipelineView, pipelineKeysOf, pipelineReviewSummary } from "../../webview/lib/pipelineView.js";

/**
 * The schema lets a complex variable stand for any list or block, and the structural
 * preview leaves it as its text (`tasks: "${var.job_tasks}"`). One bundle per list or
 * block field of a job and a pipeline, from `databricks bundle schema`, each with that
 * field (or a list's first item) set to a variable: every one the CLI accepts must go
 * through the inspector, the pipeline view and each job's full report without an error. A field a new CLI adds is tested as it appears.
 */

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const execFileAsync = promisify(execFile);

type JsonSchema = {
  $ref?: string;
  type?: string;
  pattern?: string;
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
};
type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
type Path = Array<string | number>;

const NB = "./nb";
const JOB: Json = {
  name: "rich",
  parameters: [{ name: "p1", default: "a" }],
  trigger: { table_update: { table_names: ["main.a.b"] } },
  job_clusters: [{ job_cluster_key: "c", new_cluster: { spark_version: "15.4.x-scala2.12", num_workers: 1, node_type_id: "i3.xlarge" } }],
  environments: [{ environment_key: "e", spec: { client: "1", dependencies: ["requests"] } }],
  tags: { team: "x" },
  email_notifications: { on_failure: ["a@b.c"] },
  tasks: [
    { task_key: "nb", notebook_task: { notebook_path: NB, base_parameters: { k: "v" } }, job_cluster_key: "c", libraries: [{ pypi: { package: "x" } }] },
    { task_key: "py", depends_on: [{ task_key: "nb" }], spark_python_task: { python_file: "./main.py", parameters: ["a"] }, environment_key: "e" },
    { task_key: "whl", python_wheel_task: { package_name: "p", entry_point: "m", parameters: ["a"] }, environment_key: "e" },
    { task_key: "rj", run_job_task: { job_id: "${resources.jobs.other.id}", job_parameters: { a: "b" } } },
    { task_key: "pl", pipeline_task: { pipeline_id: "${resources.pipelines.pipe.id}" } },
    { task_key: "fe", for_each_task: { inputs: "[1,2]", task: { task_key: "inner", notebook_task: { notebook_path: NB } } } },
    { task_key: "sql", sql_task: { warehouse_id: "w", file: { path: "./q.sql" }, parameters: { a: "b" } } },
    { task_key: "dbt", dbt_task: { commands: ["dbt run"] } },
    { task_key: "submit", spark_submit_task: { parameters: ["--class", "x"] }, job_cluster_key: "c" },
    { task_key: "cond", condition_task: { op: "EQUAL_TO", left: "a", right: "b" } },
  ],
};
const PIPELINE: Json = {
  name: "pipe",
  catalog: "main",
  schema: "s",
  libraries: [{ notebook: { path: NB } }, { file: { path: "./main.py" } }, { glob: { include: "./src/**" } }],
  configuration: { k: "v" },
  clusters: [{ label: "default", num_workers: 1 }],
};
const JOB_PATH: Path = ["resources", "jobs", "rich"];
const PIPELINE_PATH: Path = ["resources", "pipelines", "pipe"];

function lookup(root: JsonSchema, ref: string): JsonSchema {
  let target: unknown = root;
  for (const part of ref.replace(/^#\//, "").split("/")) target = (target as Record<string, unknown>)[part];
  return target as JsonSchema;
}

/** The schema's own shape for a field, without its `${var...}` alternative. */
function shapeOf(root: JsonSchema, node: JsonSchema): JsonSchema {
  for (;;) {
    if (node.$ref) node = lookup(root, node.$ref);
    else if (node.oneOf) node = node.oneOf.find((option) => !(option.type === "string" && option.pattern)) ?? node.oneOf[0]!;
    else return node;
  }
}

/** Every list or block under a resource, with the value the base bundle gives it. */
function variablePaths(root: JsonSchema, node: JsonSchema, at: Path, value: Json | undefined, depth = 0): Path[] {
  const shape = shapeOf(root, node);
  if ((shape.type !== "array" && shape.type !== "object") || depth > 5) return [];
  const paths: Path[] = [at];
  if (shape.type === "array") {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        paths.push([...at, index], ...variablePaths(root, shape.items ?? {}, [...at, index], item, depth + 1));
      });
    }
    return paths;
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  for (const [key, sub] of Object.entries(shape.properties ?? {})) {
    // Into every field the base fills, and one level into the empty ones.
    if (record?.[key] !== undefined || depth < 2) paths.push(...variablePaths(root, sub, [...at, key], record?.[key], depth + 1));
  }
  return paths;
}

function bundleWithVariableAt(target: Path): Json {
  const bundle = JSON.parse(JSON.stringify({
    bundle: { name: "variable-fields" },
    variables: {},
    resources: {
      jobs: { rich: JOB, other: { name: "other", tasks: [{ task_key: "o", notebook_task: { notebook_path: NB } }] } },
      pipelines: { pipe: PIPELINE },
    },
  })) as { [key: string]: Json };
  let parent: Json = bundle;
  for (const part of target.slice(0, -1)) {
    const container = parent as { [key: string]: Json };
    parent = (container[part] ??= {});
  }
  const last = target.at(-1)!;
  const container = parent as { [key: string]: Json };
  const current = container[last];
  (bundle.variables as { [key: string]: Json }).v = { type: "complex", default: current ?? {} };
  container[last] = "${var.v}";
  return bundle;
}

async function inspect(dir: string): Promise<boolean> {
  const result = await validateBundle(dir, undefined, cli);
  if (!result.ok) return false;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(result.data, dir));
  const issues = buildInspectorIssues(graph, result.data, result.issues ?? [], dir);
  for (const jobKey of Object.keys(result.data.resources?.jobs ?? {})) {
    jobReviewReport(result.data, graph, jobKey, issues, {
      targetLabel: "structural preview",
      structuralPreview: true,
      extensionVersion: "test",
      checkedAt: new Date(0),
    });
  }
  for (const key of pipelineKeysOf(result.data)) {
    const view = buildPipelineView(graph, result.data, key, issues);
    if (view) pipelineReviewSummary(view, { bundleName: "variable-fields", targetLabel: "structural preview" });
  }
  return true;
}

describe(`list and block fields set by a complex variable (${cli})`, () => {
  test("every bundle the CLI accepts goes through the inspector", async () => {
    const { stdout } = await execFileAsync(cli, ["bundle", "schema"], { maxBuffer: 64 * 1024 * 1024 });
    const root = JSON.parse(stdout) as JsonSchema;
    const definition = (name: string) => ({ $ref: `#/$defs/github.com/databricks/cli/bundle/config/resources.${name}` });
    const paths = [...new Map([
      ...variablePaths(root, definition("Job"), JOB_PATH, JOB),
      ...variablePaths(root, definition("Pipeline"), PIPELINE_PATH, PIPELINE),
    ].map((at) => [at.join("."), at])).values()];
    expect(paths.length).toBeGreaterThan(50);

    const work = await mkdtemp(path.join(os.tmpdir(), "dbi-variable-fields-"));
    const failures: string[] = [];
    let accepted = 0;
    try {
      const queue = [...paths.entries()];
      await Promise.all(Array.from({ length: 8 }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [index, at] = next;
          const dir = path.join(work, String(index));
          await mkdir(path.join(dir, "src"), { recursive: true });
          await writeFile(path.join(dir, "databricks.yml"), JSON.stringify(bundleWithVariableAt(at), null, 1));
          await writeFile(path.join(dir, "nb.py"), "# Databricks notebook source\nprint(1)\n");
          await writeFile(path.join(dir, "main.py"), "print(1)\n");
          await writeFile(path.join(dir, "q.sql"), "select 1\n");
          await writeFile(path.join(dir, "src", "a.py"), "print(1)\n");
          try {
            if (await inspect(dir)) accepted++;
          } catch (error) {
            failures.push(`${at.join(".")}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    expect(failures).toEqual([]);
    // Most variants are valid bundles, so the check above is not empty.
    expect(accepted).toBeGreaterThan(paths.length * 0.9);
  }, 600_000);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  extractBundleGraph,
  extractResourceNodes,
} from "../shared/bundleGraph.js";
import type { ParsedBundleConfig } from "../shared/bundleGraph.js";

function createParsedBundle(): ParsedBundleConfig {
  return {
    bundle: {
      name: "demo-bundle",
    },
    resources: {
      jobs: {
        ingest_job: {
          name: "Ingest Job",
          trigger: {
            periodic: {
              interval: 2,
              unit: "DAYS",
            },
          },
          run_as: {
            service_principal_name: "spn-demo",
          },
          parameters: [
            { name: "env", default: "${var.env}" },
            { name: "limit", default: "25" },
          ],
          tasks: [
            {
              task_key: "extract",
              notebook_task: {
                notebook_path: "/Workspace/extract",
                base_parameters: {
                  env: "prod",
                  batch: 10,
                },
              } as { notebook_path?: string } & {
                base_parameters?: Record<string, unknown>;
              },
              job_cluster_key: "etl-cluster",
            },
            {
              task_key: "load",
              depends_on: [{ task_key: "extract" }],
              sql_task: {
                file: {
                  path: "queries/load.sql",
                },
                warehouse_id: "${var.warehouse_id}",
                base_parameters: {
                  mode: "append",
                },
              } as {
                file?: { path?: string };
                warehouse_id?: string;
                base_parameters?: Record<string, unknown>;
              },
            },
          ],
        },
      },
      pipelines: {
        bronze_pipeline: {
          name: "Bronze Pipeline",
        },
      },
    },
  };
}

test("extractResourceNodes returns jobs and non-job resources", () => {
  const nodes = extractResourceNodes(createParsedBundle());

  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map((node) => node.id).sort(), [
    "resources.jobs.ingest_job",
    "resources.pipelines.bronze_pipeline",
  ]);
});

test("extractBundleGraph creates job, task, resource, and dependency nodes", () => {
  const graph = extractBundleGraph(createParsedBundle());

  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 3);

  const jobNode = graph.nodes.find(
    (node) => node.id === "resources.jobs.ingest_job",
  );
  assert.ok(jobNode);
  assert.equal(jobNode.nodeType, "job");
  assert.equal(jobNode.trigger, "Every 2 days");
  assert.equal(jobNode.runAs, "Service Principal / spn-demo");
  assert.deepEqual(jobNode.compute, [
    { kind: "cluster", label: "etl-cluster" },
    { kind: "sqlWarehouse", label: "warehouse_id" },
  ]);

  const extractTask = graph.nodes.find(
    (node) => node.id === "resources.jobs.ingest_job.tasks.extract",
  );
  assert.ok(extractTask);
  assert.equal(extractTask?.taskTypeLabel, "Notebook");
  assert.equal(extractTask?.subtitle, "/Workspace/extract");
  assert.deepEqual(extractTask?.parameters, [
    { name: "env", value: "prod" },
    { name: "limit", value: "25" },
    { name: "batch", value: "10" },
  ]);

  const loadTask = graph.nodes.find(
    (node) => node.id === "resources.jobs.ingest_job.tasks.load",
  );
  assert.ok(loadTask);
  assert.equal(loadTask?.taskTypeLabel, "SQL");
  assert.equal(loadTask?.subtitle, "queries/load.sql");
  assert.deepEqual(loadTask?.compute, [
    { kind: "sqlWarehouse", label: "warehouse_id" },
  ]);
  assert.deepEqual(loadTask?.parameters, [
    { name: "env", value: "env" },
    { name: "limit", value: "25" },
    { name: "mode", value: "append" },
  ]);

  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.id ===
          "resources.jobs.ingest_job.tasks.extract->resources.jobs.ingest_job.tasks.load" &&
        edge.relationship === "depends_on",
    ),
  );

  const resourceNode = graph.nodes.find(
    (node) => node.id === "resources.pipelines.bronze_pipeline",
  );
  assert.ok(resourceNode);
  assert.equal(resourceNode?.nodeType, "resource");
  assert.equal(resourceNode?.kind, "pipeline");
});

test("extractBundleGraph falls back to default compute and generated task keys", () => {
  const graph = extractBundleGraph({
    bundle: {
      name: "demo-bundle",
    },
    resources: {
      jobs: {
        unnamed_job: {
          tasks: [
            {
              spark_python_task: {
                python_file: "main.py",
              },
            },
          ],
        },
      },
    },
  });

  const jobNode = graph.nodes.find(
    (node) => node.id === "resources.jobs.unnamed_job",
  );
  assert.ok(jobNode);
  assert.deepEqual(jobNode?.compute, [
    { kind: "cluster", label: "Serverless / inherited compute" },
  ]);

  const generatedTask = graph.nodes.find(
    (node) => node.id === "resources.jobs.unnamed_job.tasks.task-1",
  );
  assert.ok(generatedTask);
  assert.equal(generatedTask?.displayName, "task-1");
  assert.equal(generatedTask?.taskTypeLabel, "Python script");
});

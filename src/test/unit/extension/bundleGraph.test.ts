import { describe, test, expect } from "@jest/globals";
import {
  extractBundleGraph,
  extractResourceNodes,
} from "../../../bundle/bundleGraph.js";
import type { ParsedBundleConfig } from "../../../bundle/bundleGraph.js";

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
                warehouse_id: "0123456789",
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

describe("extractResourceNodes", () => {
  test("returns jobs and non-job resources", () => {
    const nodes = extractResourceNodes(createParsedBundle());

    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.id).sort()).toEqual([
      "resources.jobs.ingest_job",
      "resources.pipelines.bronze_pipeline",
    ]);
  });
});

describe("extractBundleGraph", () => {
  test("creates job, task, resource, and dependency nodes", () => {
    const graph = extractBundleGraph(createParsedBundle());

    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(3);

    const jobNode = graph.nodes.find(
      (node) => node.id === "resources.jobs.ingest_job",
    );
    expect(jobNode).toBeDefined();
    expect(jobNode?.nodeType).toBe("job");
    expect(jobNode?.trigger).toBe("Every 2 days");
    expect(jobNode?.runAs).toBe("Service Principal / spn-demo");
    expect(jobNode?.compute).toEqual([
      { kind: "cluster", label: "etl-cluster" },
      { kind: "sqlWarehouse", label: "warehouse_id" },
    ]);

    const extractTask = graph.nodes.find(
      (node) => node.id === "resources.jobs.ingest_job.tasks.extract",
    );
    expect(extractTask).toBeDefined();
    expect(extractTask?.taskTypeLabel).toBe("Notebook");
    expect(extractTask?.subtitle).toBe("/Workspace/extract");
    expect(extractTask?.parameters).toEqual([
      { name: "env", value: "prod" },
      { name: "limit", value: "25" },
      { name: "batch", value: "10" },
    ]);

    const loadTask = graph.nodes.find(
      (node) => node.id === "resources.jobs.ingest_job.tasks.load",
    );
    expect(loadTask).toBeDefined();
    expect(loadTask?.taskTypeLabel).toBe("SQL");
    expect(loadTask?.subtitle).toBe("queries/load.sql");
    expect(loadTask?.compute).toEqual([
      { kind: "sqlWarehouse", label: "warehouse_id" },
    ]);
    expect(loadTask?.parameters).toEqual([
      { name: "env", value: "env" },
      { name: "limit", value: "25" },
      { name: "mode", value: "append" },
    ]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.id ===
            "resources.jobs.ingest_job.tasks.extract->resources.jobs.ingest_job.tasks.load" &&
          edge.relationship === "depends_on",
      ),
    ).toBe(true);

    const resourceNode = graph.nodes.find(
      (node) => node.id === "resources.pipelines.bronze_pipeline",
    );
    expect(resourceNode).toBeDefined();
    expect(resourceNode?.nodeType).toBe("resource");
    expect(resourceNode?.kind).toBe("pipeline");
  });

  test("falls back to default compute and generated task keys", () => {
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
    expect(jobNode).toBeDefined();
    expect(jobNode?.compute).toEqual([
      { kind: "cluster", label: "Serverless / inherited compute" },
    ]);

    const generatedTask = graph.nodes.find(
      (node) => node.id === "resources.jobs.unnamed_job.tasks.task-1",
    );
    expect(generatedTask).toBeDefined();
    expect(generatedTask?.displayName).toBe("task-1");
    expect(generatedTask?.taskTypeLabel).toBe("Python script");
  });
});

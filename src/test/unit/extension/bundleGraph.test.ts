import { describe, test, expect } from "@jest/globals";
import {
  extractBundleGraph,
  extractResourceNodes,
} from "../../../bundle/graph/bundleGraph.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";

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
  test("creates job, task, resource, and dependency nodes", async () => {
    const graph = await extractBundleGraph(createParsedBundle());

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
      { kind: "sqlWarehouse", label: "0123456789" },
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
      { kind: "sqlWarehouse", label: "0123456789" },
    ]);
    expect(loadTask?.parameters).toEqual([
      { name: "env", value: "env", expression: "${var.env}" },
      { name: "limit", value: "25" },
      { name: "mode", value: "append" },
    ]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.id ===
            "resources.jobs.ingest_job.tasks.extract->resources.jobs.ingest_job.tasks.load" &&
          edge.kind === "depends_on",
      ),
    ).toBe(true);

    const resourceNode = graph.nodes.find(
      (node) => node.id === "resources.pipelines.bronze_pipeline",
    );
    expect(resourceNode).toBeDefined();
    expect(resourceNode?.nodeType).toBe("resource");
    expect(resourceNode?.kind).toBe("pipeline");
  });

  test("falls back to default compute and generated task keys", async () => {
    const graph = await extractBundleGraph({
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

  test("attaches job cluster details to job_cluster_key compute", async () => {
    const graph = await extractBundleGraph({
      bundle: {
        name: "demo-bundle",
      },
      variables: {
        node_type_id: { default: "Standard_DS3_v2" },
      },
      resources: {
        jobs: {
          validation_job: {
            job_clusters: [
              {
                job_cluster_key: "job_cluster",
                new_cluster: {
                  spark_version: "15.4.x-scala2.12",
                  node_type_id: "${var.node_type_id}",
                  data_security_mode: "USER_ISOLATION",
                  autoscale: {
                    min_workers: 1,
                    max_workers: 2,
                  },
                },
              },
            ],
            tasks: [
              {
                task_key: "validate",
                job_cluster_key: "job_cluster",
                notebook_task: {
                  notebook_path: "notebook.py",
                },
              },
            ],
          },
        },
      },
    });

    const task = graph.nodes.find(
      (node) => node.id === "resources.jobs.validation_job.tasks.validate",
    );

    expect(task?.compute).toEqual([
      {
        kind: "cluster",
        label: "job_cluster",
        details: [
          { label: "Spark", value: "15.4.x-scala2.12" },
          {
            label: "Node type",
            value: "node_type_id",
            expression: "${var.node_type_id}",
          },
          { label: "Autoscale", value: "1 - 2 workers" },
          { label: "Security", value: "USER_ISOLATION" },
        ],
      },
    ]);
  });

  test("attaches top-level cluster resource details to existing_cluster_id references", async () => {
    const graph = await extractBundleGraph({
      bundle: {
        name: "demo-bundle",
      },
      resources: {
        clusters: {
          shared_cluster: {
            spark_version: "15.4.x-scala2.12",
            node_type_id: "i3.xlarge",
            num_workers: 2,
            data_security_mode: "SINGLE_USER",
          },
        },
        jobs: {
          validation_job: {
            tasks: [
              {
                task_key: "validate",
                existing_cluster_id: "${resources.clusters.shared_cluster.id}",
                notebook_task: {
                  notebook_path: "notebook.py",
                },
              },
            ],
          },
        },
      },
    });

    const task = graph.nodes.find(
      (node) => node.id === "resources.jobs.validation_job.tasks.validate",
    );

    expect(task?.compute).toEqual([
      {
        kind: "cluster",
        label: "shared_cluster",
        expression: "${resources.clusters.shared_cluster.id}",
        details: [
          { label: "Spark", value: "15.4.x-scala2.12" },
          { label: "Node type", value: "i3.xlarge" },
          { label: "Workers", value: "2" },
          { label: "Security", value: "SINGLE_USER" },
        ],
      },
    ]);
  });

  test("attaches pipeline resource details to pipeline tasks", async () => {
    const graph = await extractBundleGraph({
      bundle: {
        name: "demo-bundle",
      },
      resources: {
        pipelines: {
          bronze_pipeline: {
            name: "Bronze Pipeline",
            catalog: "main",
            schema: "bronze",
            channel: "CURRENT",
            edition: "CORE",
            photon: true,
            clusters: [
              {
                label: "default",
                node_type_id: "i3.xlarge",
                autoscale: {
                  min_workers: 1,
                  max_workers: 3,
                },
              },
            ],
          },
        },
        jobs: {
          validation_job: {
            tasks: [
              {
                task_key: "run_pipeline",
                pipeline_task: {
                  pipeline_id: "${resources.pipelines.bronze_pipeline.id}",
                },
              },
            ],
          },
        },
      },
    });

    const task = graph.nodes.find(
      (node) => node.id === "resources.jobs.validation_job.tasks.run_pipeline",
    );

    expect(task?.compute).toEqual([
      {
        kind: "pipeline",
        label: "bronze_pipeline",
        expression: "${resources.pipelines.bronze_pipeline.id}",
        details: [
          { label: "Name", value: "Bronze Pipeline" },
          { label: "Catalog", value: "main" },
          { label: "Schema", value: "bronze" },
          { label: "Channel", value: "CURRENT" },
          { label: "Edition", value: "CORE" },
          { label: "Photon", value: "true" },
          { label: "Cluster", value: "default" },
          { label: "Node type", value: "i3.xlarge" },
          { label: "Autoscale", value: "1 - 3 workers" },
        ],
      },
    ]);
  });

  test("infers compute by Databricks task type", async () => {
    const graph = await extractBundleGraph({
      bundle: {
        name: "demo-bundle",
      },
      resources: {
        jobs: {
          compute_job: {
            tasks: [
              {
                task_key: "if_else",
                condition_task: {
                  op: "EQUAL_TO",
                  left: "a",
                  right: "b",
                },
              },
              {
                task_key: "pipeline",
                pipeline_task: {
                  pipeline_id: "pipeline-id",
                },
              },
              {
                task_key: "dashboard",
                dashboard_task: {
                  dashboard_id: "dashboard-id",
                  warehouse_id: "dashboard-warehouse",
                },
              },
              {
                task_key: "dbt",
                dbt_task: {
                  commands: ["dbt run"],
                  warehouse_id: "dbt-warehouse",
                },
              },
              {
                task_key: "sql_default",
                sql_task: {
                  file: {
                    path: "query.sql",
                  },
                },
              },
              {
                task_key: "jar",
                spark_jar_task: {
                  main_class_name: "com.acme.Main",
                },
              },
              {
                task_key: "wheel",
                python_wheel_task: {
                  package_name: "demo",
                },
              },
              {
                task_key: "notebook",
                notebook_task: {
                  notebook_path: "notebook.py",
                },
              },
            ],
          },
        },
      },
    });

    function taskCompute(taskKey: string) {
      return graph.nodes.find(
        (node) => node.id === `resources.jobs.compute_job.tasks.${taskKey}`,
      )?.compute;
    }

    expect(taskCompute("if_else")).toEqual([]);
    expect(taskCompute("pipeline")).toEqual([
      { kind: "cluster", label: "Serverless / inherited compute" },
    ]);
    expect(taskCompute("dashboard")).toEqual([
      { kind: "sqlWarehouse", label: "dashboard-warehouse" },
    ]);
    expect(taskCompute("dbt")).toEqual([
      { kind: "sqlWarehouse", label: "dbt-warehouse" },
    ]);
    expect(taskCompute("sql_default")).toEqual([
      { kind: "sqlWarehouse", label: "Serverless / inherited SQL warehouse" },
    ]);
    expect(taskCompute("jar")).toEqual([
      { kind: "cluster", label: "Serverless / inherited compute" },
    ]);
    expect(taskCompute("wheel")).toEqual([
      { kind: "cluster", label: "Serverless / inherited compute" },
    ]);
    expect(taskCompute("notebook")).toEqual([
      { kind: "cluster", label: "Serverless / inherited compute" },
    ]);
  });
});

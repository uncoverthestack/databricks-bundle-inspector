import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { validateBundle } from "../../bundle/validateBundle.js";
import { buildBundleOverview, type OverviewItem } from "../../webview/lib/bundleOverview.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

const rows = (item: OverviewItem | undefined) =>
  Object.fromEntries(
    (item?.settings?.sections ?? []).map((section) => [
      section.title,
      section.rows.map((row) => `${row.label}: ${row.lines ? row.lines.join(" | ") : row.value}${row.raw ? ` (${row.raw})` : ""}`),
    ]),
  );

/**
 * The compute settings in the overview's details (#417), from the real CLI's output: its
 * numbers, booleans and nested fields as the CLI writes them, with each "Also set" field's
 * line from the YAML. A CLI that changes how it writes these fields fails this test.
 */
describe(`compute settings from the CLI's output (${cli})`, () => {
  test("a warehouse, a cluster, a job cluster and serverless compute show what the bundle sets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-compute-settings-"));
    created.push(dir);
    await writeFile(path.join(dir, "nb.py"), "# Databricks notebook source\nprint(1)\n");
    await writeFile(path.join(dir, "job.py"), "print(1)\n");
    await writeFile(
      path.join(dir, "databricks.yml"),
      [
        "bundle:",
        "  name: compute-settings",
        "resources:",
        "  sql_warehouses:",
        "    starter:",
        "      name: Starter Warehouse",
        "      enable_serverless_compute: true",
        "      warehouse_type: PRO",
        "      cluster_size: 2X-Small",
        "      auto_stop_mins: 10",
        "      min_num_clusters: 1",
        "      max_num_clusters: 2",
        "      channel:",
        "        name: CHANNEL_NAME_CURRENT",
        "      enable_photon: true", //                                  15
        "      permissions:",
        "        - group_name: users",
        "          level: CAN_USE",
        "  clusters:",
        "    shared:",
        "      cluster_name: shared",
        "      spark_version: 15.4.x-scala2.12",
        "      node_type_id: i3.xlarge",
        "      autoscale:",
        "        min_workers: 2",
        "        max_workers: 8",
        "      data_security_mode: SINGLE_USER",
        "      autotermination_minutes: 30",
        "      spark_conf:", //                                          29
        '        "spark.a": "1"',
        '        "spark.b": "2"',
        "  jobs:",
        "    daily:",
        "      performance_target: PERFORMANCE_OPTIMIZED",
        "      job_clusters:",
        "        - job_cluster_key: etl",
        "          new_cluster:",
        "            spark_version: 15.4.x-scala2.12",
        "            num_workers: 4",
        "            init_scripts:", //                                  40
        "              - workspace:",
        "                  destination: /Shared/init.sh",
        "      environments:",
        "        - environment_key: default",
        "          spec:",
        '            environment_version: "5"',
        "            dependencies:",
        '              - "simplejson==3.19.*"',
        "      tasks:",
        "        - task_key: on_cluster",
        "          job_cluster_key: etl",
        "          notebook_task:",
        "            notebook_path: ./nb.py",
        "        - task_key: script",
        "          environment_key: default",
        "          spark_python_task:",
        "            python_file: ./job.py",
        "        - task_key: nb",
        "          notebook_task:",
        "            notebook_path: ./nb.py",
        "        - task_key: sql",
        "          sql_task:",
        "            warehouse_id: ${resources.sql_warehouses.starter.id}",
        "            query:",
        "              query_id: q",
        "        - task_key: shared",
        "          existing_cluster_id: ${resources.clusters.shared.id}",
        "          notebook_task:",
        "            notebook_path: ./nb.py",
        "",
      ].join("\n"),
    );

    const result = await validateBundle(dir, undefined, cli);
    if (!result.ok) throw new Error(result.error.details ?? result.error.error);
    expect(Object.keys(result.data.resources?.jobs ?? {})).toEqual(["daily"]);
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(result.data, dir));
    const items = buildBundleOverview(graph).groups.flatMap((group) => group.items);
    const byId = (id: string) => items.find((entry) => entry.id === id);

    const warehouse = byId("resources.sql_warehouses.starter");
    expect(rows(warehouse)).toEqual({
      Settings: [
        "Name: Starter Warehouse",
        "Type: Serverless",
        "Cluster size: 2X-Small",
        "Auto stop: After 10 minutes",
        "Scaling: Min 1 · Max 2",
        "Channel: Current",
      ],
      Permissions: ["users: Can use"],
    });
    expect(warehouse?.settings?.alsoSet).toEqual([{ field: "enable_photon", line: 15 }]);

    const cluster = byId("resources.clusters.shared");
    expect(rows(cluster)).toEqual({
      Settings: [
        "Name: shared",
        "Runtime: 15.4.x-scala2.12",
        "Worker type: i3.xlarge",
        "Workers: 2 – 8, autoscaling",
        "Access mode: Dedicated (SINGLE_USER)",
        "Auto termination: After 30 minutes",
      ],
    });
    expect(cluster?.settings?.alsoSet).toEqual([{ field: "spark_conf", count: 2, line: 29 }]);

    const jobCluster = byId("resources.jobs.daily.job_clusters.etl");
    expect(rows(jobCluster)).toEqual({ Settings: ["Runtime: 15.4.x-scala2.12", "Workers: 4"] });
    expect(jobCluster?.settings?.alsoSet).toEqual([{ field: "init_scripts", count: 1, line: 40 }]);

    const serverless = items.find((entry) => entry.source === "default");
    expect(rows(serverless)).toEqual({
      "Environment default": ["Version: 5", "Dependencies: simplejson==3.19.*", "Tasks: script"],
      "Notebook tasks": ["Environment: Not set in the job. Databricks chooses the version.", "Tasks: nb"],
      Performance: ["daily: Performance optimized"],
    });
  });
});

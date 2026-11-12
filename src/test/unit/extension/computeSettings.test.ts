import { describe, expect, test } from "@jest/globals";
import { clusterSettings, serverlessSettings, warehouseSettings, words } from "../../../webview/lib/computeSettings.js";

const rowsOf = (settings: { sections: { title: string; rows: { label: string; value: string; raw?: string; expression?: boolean; lines?: string[] }[] }[] }) =>
  Object.fromEntries(settings.sections.map((section) => [section.title, section.rows.map((row) => `${row.label}: ${row.lines ? row.lines.join(" | ") : row.value}${row.raw ? ` (${row.raw})` : ""}${row.expression ? " [as written]" : ""}`)]));

describe("words", () => {
  test.each([
    ["CAN_MANAGE", "Can manage"],
    ["IS_OWNER", "Is owner"],
    ["PERFORMANCE_OPTIMIZED", "Performance optimized"],
    ["PRO", "Pro"],
  ])("%s", (value, expected) => expect(words(value)).toBe(expected));
});

describe("SQL warehouse", () => {
  test("the rows of its Overview page in Databricks, permissions, and the other fields with their lines", () => {
    const settings = warehouseSettings(
      {
        name: "Serverless Starter Warehouse",
        enable_serverless_compute: true,
        warehouse_type: "PRO",
        cluster_size: "2X-Small",
        auto_stop_mins: 10,
        min_num_clusters: 1,
        max_num_clusters: 1,
        channel: { name: "CHANNEL_NAME_CURRENT" },
        enable_photon: true,
        tags: { custom_tags: [{ key: "a", value: "b" }, { key: "c", value: "d" }] },
        permissions: [
          { group_name: "admins", level: "CAN_MANAGE" },
          { user_name: "someone@example.com", level: "CAN_USE" },
        ],
      },
      undefined,
      { name: 3, enable_serverless_compute: 4, cluster_size: 5, enable_photon: 9, tags: 10, permissions: 12 },
      "/b/resources/warehouses.yml",
    );
    expect(rowsOf(settings)).toEqual({
      Settings: [
        "Name: Serverless Starter Warehouse",
        "Type: Serverless",
        "Cluster size: 2X-Small",
        "Auto stop: After 10 minutes",
        "Scaling: Min 1 · Max 1",
        "Channel: Current",
      ],
      Permissions: ["admins: Can manage", "someone@example.com: Can use"],
    });
    // Only fields written in the file are listed, each with its line; Settings fields are not repeated.
    expect(settings.alsoSet).toEqual([
      { field: "enable_photon", line: 9 },
      { field: "tags", count: 1, line: 10 },
    ]);
    expect(settings.file).toBe("/b/resources/warehouses.yml");
  });

  test("a Pro or Classic warehouse, auto stop off, only a maximum", () => {
    expect(rowsOf(warehouseSettings({ warehouse_type: "CLASSIC", auto_stop_mins: 0, max_num_clusters: 3 }))).toEqual({
      Settings: ["Type: Classic", "Auto stop: Off", "Scaling: Max 3"],
    });
  });

  test("nothing set: no rows and no guessed defaults", () => {
    expect(warehouseSettings({ name: "" })).toEqual({ sections: [], alsoSet: [] });
  });

  test("a value from a variable shows for the target, or as written when unknown", () => {
    const resolve = (value: string) => (value === "${var.size}" ? "Small" : value);
    expect(rowsOf(warehouseSettings({ cluster_size: "${var.size}", channel: { name: "${var.channel}" } }, resolve))).toEqual({
      Settings: ["Cluster size: Small", "Channel: ${var.channel} [as written]"],
    });
  });
});

describe("cluster", () => {
  test("a cluster resource: runtime, worker type, autoscale, access mode by its current name", () => {
    const settings = clusterSettings({
      cluster_name: "shared",
      spark_version: "15.4.x-scala2.12",
      node_type_id: "i3.xlarge",
      autoscale: { min_workers: 2, max_workers: 8 },
      data_security_mode: "SINGLE_USER",
      autotermination_minutes: 30,
      spark_conf: { a: "1", b: "2", c: "3" },
      permissions: [{ service_principal_name: "sp-1", level: "CAN_RESTART" }],
    });
    expect(rowsOf(settings)).toEqual({
      Settings: [
        "Name: shared",
        "Runtime: 15.4.x-scala2.12",
        "Worker type: i3.xlarge",
        "Workers: 2 – 8, autoscaling",
        "Access mode: Dedicated (SINGLE_USER)",
        "Auto termination: After 30 minutes",
      ],
      Permissions: ["sp-1: Can restart"],
    });
    expect(settings.alsoSet).toEqual([{ field: "spark_conf", count: 3 }]);
  });

  test.each([
    ["USER_ISOLATION", "Standard (USER_ISOLATION)"],
    ["DATA_SECURITY_MODE_STANDARD", "Standard (DATA_SECURITY_MODE_STANDARD)"],
    ["DATA_SECURITY_MODE_DEDICATED", "Dedicated (DATA_SECURITY_MODE_DEDICATED)"],
    ["DATA_SECURITY_MODE_AUTO", "Auto (DATA_SECURITY_MODE_AUTO)"],
    // No current name in Databricks' UI: shown as written.
    ["NONE", "NONE"],
    ["LEGACY_TABLE_ACL", "LEGACY_TABLE_ACL"],
  ])("access mode %s", (mode, shown) => {
    expect(rowsOf(clusterSettings({ data_security_mode: mode })).Settings).toEqual([`Access mode: ${shown}`]);
  });

  test("a fixed number of workers, including none", () => {
    expect(rowsOf(clusterSettings({ num_workers: 0 })).Settings).toEqual(["Workers: 0"]);
  });

  test("a job cluster reads its field lines under job_clusters.<key>.", () => {
    const settings = clusterSettings(
      { spark_version: "15.4.x", spark_env_vars: { A: "1" }, init_scripts: [{}, {}] },
      undefined,
      { "job_clusters.etl.spark_version": 20, "job_clusters.etl.spark_env_vars": 21, "job_clusters.etl.init_scripts": 23, "job_clusters.other.policy_id": 30, tasks: 5 },
      "/b/resources/job.yml",
      "job_clusters.etl.",
    );
    expect(settings.alsoSet).toEqual([
      { field: "init_scripts", count: 2, line: 23 },
      { field: "spark_env_vars", count: 1, line: 21 },
    ]);
  });
});

describe("serverless", () => {
  const job = {
    environments: [
      { environment_key: "default", spec: { environment_version: "5", dependencies: ["simplejson==3.19.*", "-r requirements.txt"] } },
      { environment_key: "project", spec: { project_environment: "./pyproject.toml" } },
    ],
    performance_target: "PERFORMANCE_OPTIMIZED",
    tasks: [
      { task_key: "script", environment_key: "default" },
      { task_key: "wheel", environment_key: "default" },
      { task_key: "proj", environment_key: "project" },
      { task_key: "nb", notebook_task: { notebook_path: "./src/nb.py" } },
      { task_key: "nb_ipynb", notebook_task: { notebook_path: "./src/nb.ipynb" } },
      { task_key: "sql", sql_task: { file: { path: "./q.sql" } } },
    ],
  };

  test("each environment the tasks use, notebook tasks saying only what the bundle says, and performance", () => {
    const settings = serverlessSettings([{ jobKey: "daily", job, taskKeys: ["script", "wheel", "proj", "nb", "nb_ipynb", "sql"] }]);
    expect(rowsOf(settings)).toEqual({
      "Environment default": ["Version: 5", "Dependencies: simplejson==3.19.* | -r requirements.txt", "Tasks: script, wheel"],
      "Environment project": ["Project: ./pyproject.toml", "Tasks: proj"],
      "Notebook tasks": [
        "Environment: Not set in the job. Databricks chooses the version.",
        "Tasks: nb",
        "Environment: Not set in the job. The notebook may set its own.",
        "Tasks: nb_ipynb",
      ],
      Performance: ["daily: Performance optimized"],
    });
    expect(settings.alsoSet).toEqual([]);
  });

  test("several jobs: an environment and a task are named with their job", () => {
    const settings = serverlessSettings([
      { jobKey: "a", job, taskKeys: ["script", "nb"] },
      { jobKey: "b", job: { tasks: [{ task_key: "nb", notebook_task: { notebook_path: "x.py" } }] }, taskKeys: ["nb"] },
    ]);
    expect(Object.keys(rowsOf(settings))).toEqual(["Environment default · a", "Notebook tasks", "Performance"]);
    expect(rowsOf(settings)["Notebook tasks"]).toEqual(["Environment: Not set in the job. Databricks chooses the version.", "Tasks: a.nb, b.nb"]);
  });

  test("an environment key the job doesn't have is not given settings", () => {
    const settings = serverlessSettings([{ jobKey: "j", job: { tasks: [{ task_key: "t", environment_key: "missing" }] }, taskKeys: ["t"] }]);
    expect(rowsOf(settings)).toEqual({ "Environment missing": ["Version: Not in the job's environments", "Tasks: t"] });
  });

  test("no tasks with environments, notebooks or a performance target: nothing", () => {
    expect(serverlessSettings([{ jobKey: "j", job: { tasks: [{ task_key: "q", sql_task: {} }] }, taskKeys: ["q"] }])).toEqual({ sections: [], alsoSet: [] });
  });
});

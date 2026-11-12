# Supported resources

The inspector has views or checks for the bundle resource groups below. It has no checks yet for any other resource group; `databricks bundle validate` still checks its settings. The inspector's own checks are described in [Every check](checks.md).

For bundle syntax and configuration examples, see the official [Databricks bundle resource reference](https://docs.databricks.com/aws/en/dev-tools/bundles/resources) and [bundle configuration reference](https://docs.databricks.com/aws/en/dev-tools/bundles/settings). Each resource group in the table links to its Databricks reference. Those pages describe what Databricks can deploy; the table describes what this inspector checks and displays.

| Resource group (Databricks reference) | Status | What the inspector does |
| --- | --- | --- |
| [`jobs`](https://docs.databricks.com/aws/en/dev-tools/bundles/resources#jobs) | View and checks | Job and task graph, task details, dependency and duplicate-key checks, local file and library checks, and code checks for widgets, task values and secrets. |
| [`pipelines`](https://docs.databricks.com/aws/en/dev-tools/bundles/resources#pipelines) | View and checks | Its own pipeline view, links to jobs that run the pipeline, local library and source checks, and secret references in supported source code and cluster settings. Pipelines without a job are included. Its data flow is read from its SQL sources: the tables and views they create and what each one reads. Tables in Python sources are not shown yet. |
| [`secret_scopes`](https://docs.databricks.com/aws/en/dev-tools/bundles/resources#secret_scopes) | Some checks | Matches secret references against bundle scope names and reports code that uses a resource key instead of its scope name. No view of its own. |
| [`clusters`](https://docs.databricks.com/aws/en/dev-tools/bundles/resources#clusters) | Some checks | Links secret references in a cluster's settings to the tasks that use that cluster. No view of its own. |
| Every other resource group | No checks yet | No view or checks. They are listed under [Not supported yet](#not-supported-yet). When a bundle has no jobs and no pipelines, the panel shows the [bundle overview](usage.md#bundle-overview), where each of these resources is a box marked "not checked yet". |

The graph's resource selector lists jobs and pipelines only.

Checks on source code read Python and SQL, including supported notebook formats. Scala and R code is not read. Bundle-wide checks, such as include patterns and unresolved variables, are documented in [Every check](checks.md).

## Not supported yet

These resource groups are in the bundle schema of the latest Databricks CLI, but the inspector has no view or checks for them. `databricks bundle validate` still checks their settings. The second column is the first CLI release whose bundle schema has the group, counting from v0.299.0, the oldest CLI the inspector supports.

| Resource group | In the CLI since |
| --- | --- |
| `feature_specs` | v1.26.0 |
| `postgres_data_apis` | v1.25.0 |
| `data_quality_monitors` | v1.24.0 |
| `materialization_sets` | v1.24.0 |
| `features` | v1.22.0 |
| `mcp_services` | v1.17.0 |
| `model_provider_services` | v1.17.0 |
| `model_services` | v1.17.0 |
| `postgres_snapshot_schedules` | v1.16.0 |
| `cluster_policies` | v1.14.0 |
| `secrets` | v1.12.0 |
| `instance_pools` | v1.9.0 |
| `job_runs` | v1.7.0 |
| `postgres_databases` | v1.4.0 |
| `postgres_roles` | v1.4.0 |
| `genie_spaces` | v1.3.0 |
| `vector_search_indexes` | v1.1.0 |
| `postgres_catalogs` | v1.0.0 |
| `postgres_synced_tables` | v1.0.0 |
| `alerts` | v0.299.0 or earlier |
| `apps` | v0.299.0 or earlier |
| `catalogs` | v0.299.0 or earlier |
| `dashboards` | v0.299.0 or earlier |
| `database_catalogs` | v0.299.0 or earlier |
| `database_instances` | v0.299.0 or earlier |
| `experiments` | v0.299.0 or earlier |
| `external_locations` | v0.299.0 or earlier |
| `model_serving_endpoints` | v0.299.0 or earlier |
| `models` | v0.299.0 or earlier |
| `postgres_branches` | v0.299.0 or earlier |
| `postgres_endpoints` | v0.299.0 or earlier |
| `postgres_projects` | v0.299.0 or earlier |
| `quality_monitors` | v0.299.0 or earlier |
| `registered_models` | v0.299.0 or earlier |
| `schemas` | v0.299.0 or earlier |
| `sql_warehouses` | v0.299.0 or earlier |
| `synced_database_tables` | v0.299.0 or earlier |
| `vector_search_endpoints` | v0.299.0 or earlier |
| `volumes` | v0.299.0 or earlier |

A test reads this list: when a new CLI release adds a resource group that is in neither table on this page, the test fails until the group is added here. A group moves to the table above once the inspector has a view or checks for it.

The inspector tells the Databricks CLI not to run bundle Python or scripts, so resources defined only by bundle Python are not shown. See [How it works](usage.md#how-it-works) for what the CLI does when the inspector runs it, and [Setup and usage](usage.md) for the views.

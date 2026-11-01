# Supported resources

The inspector has views or checks for the bundle resource groups below. It has no checks yet for any other resource group; `databricks bundle validate` still checks its settings. The inspector's own checks are described in [Every check](checks.md).

For bundle syntax and configuration examples, see the official [Databricks bundle resource reference](https://docs.databricks.com/aws/en/dev-tools/bundles/resources) and [bundle configuration reference](https://docs.databricks.com/aws/en/dev-tools/bundles/settings). Each resource group in the table links to its Databricks reference. Those pages describe what Databricks can deploy; the table describes what this inspector checks and displays.

| Resource group (Databricks reference) | Status | What the inspector does |
| --- | --- | --- |
| [`jobs`](https://docs.databricks.com/aws/en/dev-tools/bundles/resources#jobs) | View and checks | Job and task graph, task details, dependency and duplicate-key checks, local file and library checks, and code checks for widgets, task values and secrets. |
| [`pipelines`](https://docs.databricks.com/aws/en/dev-tools/bundles/resources#pipelines) | View and checks | Its own pipeline view, links to jobs that run the pipeline, local library and source checks, and secret references in supported source code and cluster settings. Pipelines without a job are included. Tables defined inside pipeline code are not shown. |
| [`secret_scopes`](https://docs.databricks.com/aws/en/dev-tools/bundles/resources#secret_scopes) | Some checks | Matches secret references against bundle scope names and reports code that uses a resource key instead of its scope name. No view of its own. |
| [`clusters`](https://docs.databricks.com/aws/en/dev-tools/bundles/resources#clusters) | Some checks | Links secret references in a cluster's settings to the tasks that use that cluster. No view of its own. |
| Every other resource group | No checks yet | No view or checks. When a bundle has no jobs, the graph panel names the resource groups it contains. |

The graph's resource selector lists jobs and pipelines only.

Checks on source code read Python and SQL, including supported notebook formats. Scala and R code is not read. Bundle-wide checks, such as include patterns and unresolved variables, are documented in [Every check](checks.md).

The inspector tells the Databricks CLI not to run bundle Python or scripts, so resources defined only by bundle Python are not shown. See [How it works](usage.md#how-it-works) for what the CLI does when the inspector runs it, and [Setup and usage](usage.md) for the views.

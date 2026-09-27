# Current Job Parameter Pattern

This fixture follows the current Databricks guidance to use bundle variables for values that vary by target and job parameters for values that should be overridable at run time.

Open `databricks.yml` and inspect the bundle.

Expected behavior:

- Target selection changes the resolved `schema` variable.
- Job parameters show defaults backed by bundle variables.
- Task `base_parameters` using `{{job.parameters.*}}` are treated as runtime parameter references, not unresolved bundle variables.
- The SQL file reference opens from the graph.

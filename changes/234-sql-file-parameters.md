Added

- **Warns when a SQL file reads a `:name` parameter its task doesn't pass** ([#234](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/234)). A SQL file task fills `:catalog`-style markers from its `sql_task.parameters` and the job's parameters; one neither passes deploys fine and fails the run with `UNBOUND_SQL_PARAMETER`. New code `sql_parameter_not_set`, with a "Did you mean" when a passed name is close. Casts, JSON paths, comments and strings are not counted.

Added

- **Warns when a SQL file's `{{name}}` parameter may fail the run or give wrong results** ([#484](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/484)). A `{{name}}` the task doesn't pass is left as written: inside quotes the query still runs and can succeed with wrong results, and outside quotes the run fails. A passed `{{name}}` inside quotes fails too, because Databricks already adds quotes. `bundle validate` and `bundle deploy` pass in all three cases. The warning highlights the placeholder in the SQL file.

Added

- **SQL conditions, synced table sync modes and feature schedules on the bundle overview** ([#737](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/737)). A job with a `sql_condition` on its schedule or trigger says `Every hour · if SQL condition`, and its details say which query must return rows, or change value, and on which warehouse. Synced tables show **Continuous**, **Triggered** or **Snapshot**, on the overview and on the Lakebase branches page. A materialization set lists each feature's schedule in its details, with the cron as written.

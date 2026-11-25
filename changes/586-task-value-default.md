Fixed

- **A task value read with a default no longer gets the "may not set value" warning** ([#586](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/586)). `dbutils.jobs.taskValues.get(..., default="fallback")`, by keyword or as the third argument, returns the default when the key isn't set, so the job runs. `default=None`, and `debugValue` on its own, still get the warning: both fail in a job run. Checked by job runs on Databricks CLI v1.28.0.

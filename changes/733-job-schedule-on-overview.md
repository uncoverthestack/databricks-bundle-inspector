Changed

- **A job's schedule shows on its box in the bundle overview, not on its tasks** ([#733](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/733)). The box says what starts the job in a few words, such as `3 tasks · Every hour`, `Continuous`, `On table update` or `On file arrival`, with `· Paused` when it's paused. Its details have the time zone and cron, or the tables or file path. A task's details no longer show a Schedule row. A `continuous` job used to show no trigger at all; it now says Continuous here and in the copied reports.

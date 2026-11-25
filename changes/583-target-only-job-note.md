Added

- **A job written only under a target says it wasn't checked** ([#583](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/583)). With no target picked, a job such as `targets.prod.resources.jobs.nightly` isn't in the graph and none of the job checks run on it. The panel's Issues list now has a note under "Jobs Not Checked": `Job "nightly" is only in target "prod": pick prod to check it.` Picking the target checks the job. The note is only in the panel, not in VS Code's Problems panel.

Fixed

- **With a target picked, each task lists the variables it uses** ([#230](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/230)). The task panel's **Variables** section was empty in target mode, and the header's Variables list marked every variable "Not used by this job": the Databricks CLI gives a target its values with every `${var...}` already replaced, so none were found. They now come from the structural preview, which keeps them, and are shown with the target's values. What the checks report is unchanged.

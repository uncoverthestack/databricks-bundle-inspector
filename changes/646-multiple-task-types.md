Added

- **A task with more than one task type is reported** ([#646](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/646)). A target that gives a task a different type, such as a notebook in place of a Python file, adds the new type beside the old one. Deploy passes, and Databricks runs only one of them, so the target's code may never run.

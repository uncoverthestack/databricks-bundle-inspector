Changed

- **The extension's log no longer copies the Databricks CLI's output** ([#318](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/318)). When a CLI command fails, the log line names the CLI, bundle and target, the exit code or signal, and how much output there was, instead of the CLI's whole output and error text, which can include the resolved bundle and its variable values. The graph and the Problems panel show the same messages as before.

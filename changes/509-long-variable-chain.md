Fixed

- **A long chain of variables no longer stops the inspection** ([#509](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/509)). The variable loop check failed with "Maximum call stack size exceeded" on about 6,000 or more variables that each refer to the next, and no findings showed. It now checks chains of any length the CLI accepts.

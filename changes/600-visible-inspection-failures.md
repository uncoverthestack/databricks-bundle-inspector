Fixed

- **Failed checks no longer look like a clean bundle** ([#600](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/600)). Unexpected CLI exits remain failures even if they printed JSON. Sign-in errors no longer hide unrelated CLI warnings. Unreadable source files show which checks failed. A checker failure keeps earlier findings marked out of date and adds an error, and slower older checks cannot replace newer findings.

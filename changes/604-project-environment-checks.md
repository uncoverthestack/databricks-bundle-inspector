Fixed

- **Project environments check the settings the run actually reads** ([#604](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/604)). Parse the Databricks table in `pyproject.toml`, so a version in another table or an empty version no longer looks valid. Warn about project versions below 5 and project files left out of the upload, at their YAML references. Valid version 5 and base environments stay quiet.

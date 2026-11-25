Fixed

- **A new resource file is checked when `include` starts with `./`** ([#625](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/625)). With `include: ["./resources/*.yml"]`, which the Databricks CLI loads like `resources/*.yml`, a file created under `resources/` was not re-checked, so its problems stayed hidden until another save. New files are now matched against `include` the way the CLI reads it, as well as the way they were before, so no re-check is lost.

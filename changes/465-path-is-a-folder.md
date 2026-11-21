Added

- **A notebook or file path that points at a folder is reported** ([#465](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/465)). New error `path_is_a_folder`, for tasks and pipeline `notebook` and `file` libraries. `bundle validate` without a target passes, and with one the CLI turns it down with "unable to determine if ... is a notebook: ... is a directory".

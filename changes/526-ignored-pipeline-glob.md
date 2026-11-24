Fixed

- **A pipeline glob whose files are all left out of the upload gets "Not deployed"** ([#526](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/526)). When `.gitignore` or `sync.exclude` leaves out every file under `include: ../src/dlt/**`, deploy uploads nothing there, and the pipeline update fails with `LIBRARY_FILE_NOT_FOUND`. `bundle validate` and deploy pass. The warning names the rule and the `sync.include` pattern to add, such as `src/dlt/**`.

Fixed

- **A path with the wrong letter case is "File not found" on every OS, with the right one suggested** ([#475](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/475)). `./Notebooks/Main.py` for `notebooks/main.py` passed on macOS and Windows, which ignore case, then the job failed with "Unable to access the notebook", because the workspace doesn't. Linux already reported it; it now also says "Did you mean "./notebooks/main.py"?", with a quick fix.

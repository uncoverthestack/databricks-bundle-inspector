Fixed

- **A notebook path with the wrong letter case and no extension gets the right suggestion on every OS** ([#477](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/477)). `./Notebooks/Main` for `notebooks/main.py` suggested `./Notebooks/Main.py` on macOS and Windows, whose quick fix still failed at run time, and nothing on Linux. It now suggests `./notebooks/main.py`, with a quick fix.

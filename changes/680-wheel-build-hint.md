Changed

- **A missing wheel in a `pyproject.toml` project says why deploy doesn't build it** ([#680](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/680)). With no `artifacts` and no `setup.py`, `bundle deploy` builds no wheel, so `dist/*.whl` must be built first. The fix now says so: build it before deploy (for example `uv build --wheel`), or add an `artifacts` entry with `build: uv build --wheel`. Found in public bundles on GitHub whose CI builds the wheel before deploy.

Fixed

- **Findings refresh after four more kinds of file change** ([#590](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/590)). A finding stayed on screen after the fix until something else triggered a check when the change was: a file a library glob matches, such as a wheel built into `dist/` for `./dist/*.whl`; the `pyproject.toml` a job's `project_environment` names, or a local environment dependency; a `.gitignore` that lists itself; or a file in a pipeline glob folder outside the bundle folder, such as `../external/**`.

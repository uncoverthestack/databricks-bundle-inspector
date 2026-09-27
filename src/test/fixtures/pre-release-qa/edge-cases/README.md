# Pre-Release QA Edge Cases

Open `databricks.yml` in the VS Code Extension Host and run `Inspect Databricks Bundle`.

This bundle is intentionally compact but covers several release-blocking edge cases:

- Nested include glob: `resources/**/*.yml`
- Resource YAML located below `resources/jobs` and `resources/pipelines`
- Task file paths relative to those nested YAML files
- A `for_each_task.task` nested task
- Target-specific variables
- A workspace notebook path that must not be treated as a local missing file
- Pipeline source glob resolution

Expected behavior:

- `generate_items` should resolve `../../src/tasks/generate_items.py`.
- `pipeline_from_nested_yaml` should resolve `../../src/dlt/**`.
- The workspace notebook path should be marked as remote/workspace, not missing local.
- `process_each_item` contains a nested task that references an intentionally missing file. The inspector should make that risk visible.
- In target mode, `${var.schema}` should resolve from the selected target.

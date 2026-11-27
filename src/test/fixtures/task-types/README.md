# A task with more than one task type (issue 646)

A target's task settings are joined with the base task's by `task_key`, so a target that sets another task type leaves the task with two. Recorded for the structural preview, which doesn't apply a target's settings, so only the cases written in the base are reported here. The target swaps are covered in `jobSettings.test.ts` with the jobs as the CLI resolves them with `-t prod`.

Checked live on 2026-11-27, Databricks CLI v1.28.0, 2 deploys, settings read back with `databricks jobs get`:

- `bundle validate` passes and `bundle deploy` passes. Databricks keeps one type: beside `spark_python_task`, `sql_task`, `condition_task` and `run_job_task`, it dropped `notebook_task`, on either side.
- Two types written in one task with no target deploy the same way.
- A target that only changes the notebook path, or another setting, deploys and runs the target's notebook.

| Task | Case | Reported |
|---|---|---|
| `py_to_nb` | target swaps a Python file for a notebook | with `-t prod` |
| `nb_to_py` | target swaps a notebook for a Python file | with `-t prod` |
| `both_in_base` | two types in one task, no target | yes |
| `loop` | for-each inner task with two types | yes |
| `same_type_new_path` | target changes the notebook path | no |
| `other_setting` | target changes `timeout_seconds` | no |
| `one_type` | one type, no override | no |

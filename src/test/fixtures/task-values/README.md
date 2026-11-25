# Task values

Tasks pass values with `dbutils.jobs.taskValues.set(key=..., value=...)` and read them with `dbutils.jobs.taskValues.get(taskKey=..., key=...)` or `{{tasks.<task>.values.<key>}}` ([docs](https://docs.databricks.com/aws/en/jobs/task-values)). Databricks reports a missing key or a wrongly named task as an error when the job runs. `databricks bundle validate` reports "Validation OK!" for this bundle (CLI v1.17.0).

| Task | Reads | Inspector |
|---|---|---|
| `consumer` | `producer.row_count` | No issue: `producer` is upstream and sets it |
| `consumer` | `producer.rowcount` | Warning: `producer` may not set `rowcount`. Did you mean `row_count`? |
| `wrong_task` | `prodcer.row_count` | Warning: task `prodcer` may not exist. Did you mean `producer`? |
| `not_upstream` | `producer.run_id` | Warning: `producer` isn't upstream, so the value may not be set yet |
| `transitive` | `producer.run_id` through `consumer` | No issue: upstream through `depends_on` |
| `transitive` | `py_producer.py_key` | No issue: set in a Python file task |
| `transitive` | `dynamic_producer.anything` | No issue: that task sets a key held in a variable |
| `yaml_refs` | `{{tasks.producer.values.row_count}}` | No issue |
| `yaml_refs` | `{{tasks.producer.values.missing}}` | Warning: `producer` may not set `missing` |
| `defaults` | `optional_keyword` with `default="fallback"`, and `optional_positional` with a third positional argument | No issue: the read gets the default (job run, CLI v1.28.0, #586) |
| `defaults` | `none_default` with `default=None` | Warning: `default=None` still raises `ValueError` (job run, #586) |
| `defaults` | `debug_only` with only `debugValue` | Warning: `debugValue` is only used outside a job (job run, #586) |
| `defaults` | `read_twice`, once with a default and once without | Warning on the read without one |
| `defaults` | `variable_default` with `default=fallback` (a variable) | No issue: the value can't be known, so no guess |

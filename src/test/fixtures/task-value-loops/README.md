# task-value-loops

Fixture for task values of a for-each task and a task reading its own values (#601). One job per case. Each loop is a for-each task `loop` whose inner task `inner` sets `result`.

| Job | Case | Inspector |
|---|---|---|
| `loop_key` | `get(taskKey="loop", key="result")` after the loop | `task_value_key_not_set`, suggests `inner` |
| `inner_key` | `get(taskKey="inner", key="result")` after the loop | nothing |
| `loop_key_default` | the loop's key, with `default=0` | nothing |
| `inner_key_typo` | `get(taskKey="inner", key="resutl")` | `task_value_key_not_set`, suggests `result` |
| `inner_key_no_depends` | the inner task's key, no `depends_on` on the loop | `task_value_not_upstream`, names `loop` |
| `yaml_inner_key` | `{{tasks.inner.values.result}}` in `base_parameters` | nothing |
| `yaml_loop_key` | `{{tasks.loop.values.result}}` in `base_parameters` | `task_value_key_not_set`, suggests `inner` |
| `self_never_set` | task `selfread` reads its own `never_set`, never set | `task_value_key_not_set` |
| `self_sets` | sets `mine`, then reads its own `mine` | nothing |
| `self_default` | its own `never_set`, with `default=0` | nothing |
| `self_runs_other` | its own `never_set`, after a `%run` | nothing: the run notebook may set it |

What Databricks does with these is in the live probes `task_value_for_each_loop_key`, `task_value_for_each_loop_key_yaml` and `task_value_self_read` (src/test/liveRules/probes).

`validated-bundle.json` is the CLI's structural preview output, captured with no credentials (`DATABRICKS_CONFIG_FILE=/dev/null`).

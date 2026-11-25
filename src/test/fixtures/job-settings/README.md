# job-settings

Fixture for the job setting checks from #237. `bundle validate` accepts every case. The deploy results are from Databricks CLI v1.28.0 against a serverless workspace (2026-11-25), one bundle per case, two runs each. A broken case fails the same way when it is an edit of a job already deployed.

| Job and setting | Case | Deploy | Inspector |
|---|---|---|---|
| `two_triggers` | `schedule` and `trigger` | fails: `Invalid trigger settings. One of 'schedule', 'trigger' or 'continuous' can be set.` | `multiple_job_triggers` |
| `one_trigger` | `schedule` only | deploys | nothing |
| `parameter_names`: `bad name` | a space | fails: `The specified parameter name contains an invalid character, only alphanumeric, -, _ and . characters are permitted.` | `invalid_job_parameter_name` |
| `parameter_names`: `a_b-c.d`, `.a` | letters, digits, `-`, `_`, `.` | deploys | nothing |
| `task_keys`: `"load "` | a trailing space | fails: `Task key 'load ' contains an invalid character. Only alphanumeric, - and _ characters are permitted.` | `invalid_task_key` |
| `task_keys`: `lo-ad_1`, `-` | letters, digits, `-`, `_` | deploys | nothing |
| `task_keys`: `loop`'s inner task `in ner` | a space in an inner task key | fails, as `"load "` | `invalid_task_key` on `loop` |
| `outcomes`: `after_plain` | `outcome: "true"` on a notebook task | fails: `The dependency on a non-if/else condition "plain" specifies an outcome "true". Outcomes can only be specified for if/else condition dependencies.` | `outcome_without_condition` |
| `outcomes`: `capital` | `outcome: "True"` on a condition task | fails: `The dependency on task "check" specifies invalid outcome "True". Valid values are "true" and "false"` | `invalid_outcome` |
| `outcomes`: `on_true`, `on_bool` | `"true"`, and unquoted `true` | deploys | nothing |
| `for_each_inputs`: `not_json`, `an_object`, `nested`, `has_null`, `mixed` | `not json`, `{"a": 1}`, `[[1, 2]]`, `[null, 1]`, `["a", {"k": "v"}]` | fails: `The JSON string in the inputs field should be an array of primitives or objects.` | `for_each_inputs_not_array` |
| `for_each_inputs`: `plain_values`, `objects`, `empty`, `from_parameter` | `["a", 1, 2.5, true]`, `[{"a": 1}, {"b": [1, 2]}]`, `[]`, `{{job.parameters.items}}` | deploys | nothing |

`validated-bundle.json` is the CLI's structural preview output, captured with no credentials (`DATABRICKS_CONFIG_FILE=/dev/null`): the findings need no login. The baseline is the same on CLI v0.299.0 to v1.28.0.

# task-graph

Fixture for the job checks from #135. One job per case. `bundle validate` accepts every one of them (Databricks CLI 0.299.0 to 1.21.0); the deploy results are from CLI 1.21.0 against a serverless workspace.

| Job | Case | Deploy | Inspector |
|---|---|---|---|
| `unknown_dependency` | `report` depends on `laod`; the task is `load` | fails: `Invalid dependency graph ... does not contain task with key` | `unknown_task_dependency`, suggests `load` |
| `other_job_dependency` | depends on a task of `first_job` | fails, as above | `unknown_task_dependency`, names `first_job` |
| `self_dependency` | `alone` depends on itself | fails: `can not reference itself` | `task_dependency_loop` |
| `two_task_loop` | `x` and `y` depend on each other | fails: `circular dependencies are not allowed` | `task_dependency_loop` on both |
| `three_task_loop` | `a`, `b`, `c` in a loop; `after_loop` waits on `c` | fails, as above | `task_dependency_loop` on `a`, `b`, `c`; nothing on `after_loop` |
| `duplicate_task_key` | two tasks `same` in one list | deploys one merged task (timeout from the first, notebook from the second) | `duplicate_task_key` |
| `duplicate_parameter` | parameter `env` twice | deploys one, default `"2"` | `duplicate_job_parameter` |
| `duplicate_in_target` | `dev` lists `twice` twice | deploys one merged task | `duplicate_task_key`, in `databricks.yml` |
| `target_override` | `dev` overrides task `load` and parameter `env` | deploys the override, as intended | nothing |
| `control` | `second` lists `first` twice in `depends_on` | deploys | nothing |

`validated-bundle.json` is the CLI's structural preview output, captured with no credentials (`DATABRICKS_CONFIG_FILE=/dev/null`): the findings need no login. `validated-bundle.dev.json` is the `dev` target's output, captured against a local stand-in workspace (user `tester@example.com`), with `bundle.git` removed because it holds the branch and commit of the capture. In a real target the CLI sorts the tasks and merges duplicates; the findings stay the same, as `src/test/unit/extension/taskGraphFixture.test.ts` and the real-CLI matrix check.

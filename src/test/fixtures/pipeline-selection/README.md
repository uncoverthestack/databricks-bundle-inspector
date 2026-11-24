# Pipeline task selections (issue 539)

Tasks `c0` to `c7` are the live test of 2026-11-24: CLI v1.27.0, a serverless SQL pipeline with two materialized views (`t_bronze`, `t_silver`), each task run in order, the whole job run twice with the same results. `bundle validate` and `bundle deploy` passed every case.

| Task | Selection | Run | Inspector |
|---|---|---|---|
| `c0_full` | none | succeeded | nothing |
| `c1_known` | `refresh_selection: [t_silver]` | succeeded | nothing |
| `c2_unknown` | `refresh_selection: [t_nope]` | `INVALID_REFRESH_SELECTION.TABLE_NOT_FOUND` | warning |
| `c3_case` | `refresh_selection: [T_SILVER]` | `TABLE_NOT_FOUND` | warning, "Did you mean" |
| `c4_mixed` | `refresh_selection: [t_silver, t_nope]` | `TABLE_NOT_FOUND` | warning on `t_nope` |
| `c5_full_unknown` | `full_refresh_selection: [t_nope]` | `TABLE_NOT_FOUND` | warning |
| `c6_flow_unknown` | `refresh_flow_selection: [t_nope]` | `INVALID_REFRESH_SELECTION.FLOW_NOT_FOUND` | warning |
| `c7_qualified` | `refresh_selection: [<catalog>.<schema>.t_silver]` | succeeded | nothing (the schema is a `${resources...}` reference, so full names aren't judged) |

Each failing update was retried 6 times, about 11 minutes, before the task failed: 1 try plus the default 5 retries (`pipelines.numUpdateRetryAttempts`).

A second live test the same day (two runs, `pipelines.numUpdateRetryAttempts: "0"`, so each failure was tried once) asked whether a name only needs to be a table in the catalog:

| Selection | In the catalog? | Run |
|---|---|---|
| `t_silver`, the pipeline's own (control) | yes | succeeded |
| `t_other`, made by another pipeline in the same schema | yes | `TABLE_NOT_FOUND`, "does not exist in the graph" |
| `t_gone`, once defined by this pipeline, its SQL since removed and the pipeline updated | yes, still | `TABLE_NOT_FOUND`, "does not exist in the graph" |

So a selection names the tables in the pipeline's code, which for a SQL pipeline its SQL files describe.

`c8` to `c10` were not run live: a full name in another schema (`main.other.t_silver`) is a different table; a pipeline with Python sources is not judged; a `for_each_task`'s inner pipeline task is checked like any other.

The live run used the schema `sandbox.dbi_refresh_test`; here it is `pipeline_selection`, which changes nothing the inspector compares.

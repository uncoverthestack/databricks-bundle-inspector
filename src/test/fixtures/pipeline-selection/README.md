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

Each failing update was retried 6 times, about 11 minutes, before the task failed.

`c8` to `c10` were not run live: a full name in another schema (`main.other.t_silver`) is a different table; a pipeline with Python sources is not judged; a `for_each_task`'s inner pipeline task is checked like any other.

The live run used the schema `sandbox.dbi_refresh_test`; here it is `pipeline_selection`, which changes nothing the inspector compares.

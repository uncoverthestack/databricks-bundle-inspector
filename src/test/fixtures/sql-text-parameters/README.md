# SQL file `{{name}}` text parameters (issue 484)

The SQL files are the ones run live on 2026-11-24 (Databricks CLI v1.27.0, serverless SQL warehouse, two runs each, with `:name` controls). Results, as recorded on issue 484:

| File | Passed? | Live result | Expected finding |
|---|---|---|---|
| `u_string.sql` | no | ran, the text stayed as written | `sql_parameter_not_set`, "may succeed with wrong results" |
| `u_where.sql` | no | ran, 0 rows, no error | same |
| `u_value.sql` | no | `PARSE_SYNTAX_ERROR` | `sql_parameter_not_set`, "the run may fail" |
| `u_table.sql` | no | `PARSE_SYNTAX_ERROR` | `sql_parameter_not_set`, and `sql_parameter_as_name`: passed, the quoted value fails too (#707) |
| `u_comment.sql` | no | ran | none |
| `p_value.sql` | yes | ran, value filled in quoted | none |
| `p_string.sql` | yes | `PARSE_SYNTAX_ERROR`, became `''2026-11-24''` | `sql_parameter_quoted` |

Not run live, so only the cases above are trusted as facts. The rest follow from them or are left alone:

- `p_double.sql`: `"{{run_date}}"` is a string in Databricks SQL like `'...'`, so it gets `sql_parameter_quoted`.
- `p_part.sql`: a passed parameter inside a longer string (`'%{{run_date}}%'`) was not tested: no finding.
- `not_checked.sql`: `{{ run_date }}` with spaces and dotted names like `{{job.start_time}}` were not tested: no finding.
- `u_twice.sql`: one warning per name and place, like `:name`.
- Task `near_name` passes `run_dt`: the warning ends with "Did you mean".
- Job `sql_text_job_parameter` passes `run_date` as a job parameter to `p_value.sql`; job parameters fill `{{name}}` too (2026-11-11): no finding.

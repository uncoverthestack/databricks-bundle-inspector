# SQL file parameters

A SQL file task (`sql_task.file`) fills the file's `:name` parameter markers from the task's `sql_task.parameters` and the job's `parameters`. A marker neither passes fails the run with `[UNBOUND_SQL_PARAMETER]`; deploy succeeds. Tested by running each case on a serverless SQL warehouse (CLI v1.24.0, issue 234). `databricks bundle validate` reports "Validation OK!" for this bundle (CLI v1.25.0).

| Task | File reads | Passed | Inspector |
|---|---|---|---|
| `not_passed` | `:catalog` | nothing | Warning: may not pass `catalog` |
| `passed` | `:catalog` | `catalog` | No issue |
| `from_job` (job `job_parameters`) | `:catalog` | job parameter `catalog` | No issue: job parameters reach SQL file tasks |
| `identifier` | `IDENTIFIER(:catalog)` | `catalog` | No issue |
| `not_markers` | `::int`, `'12:30'`, `':catalog'`, `raw:owner`, `:region` and `:limit_rows` in comments, `'${legacy_name}'` | nothing | No issue: casts, strings, a JSON path and comments are not markers; legacy `${}` is not checked |
| `passes_unused` | `:catalog` | `catalog`, `unused` | No issue: passing an extra parameter runs fine |
| `other_case` | `:Catalog` | `catalog` | Warning: may not pass `Catalog`. Did you mean `catalog`? Names are case sensitive: the run fails with `UNBOUND_SQL_PARAMETER` (tested, CLI v1.25.0) |
| `near_name` | `:schema` | `schema_name` | Warning: may not pass `schema`. Did you mean `schema_name`? |
| `each_day` inner task | `:day`, `:catalog` twice | `day` | Warning once: may not pass `catalog` |
| `from_git` job | `:catalog` | nothing | No issue: the file comes from Git |

`{{name}}` text is not checked. Databricks' own examples use it (`USE CATALOG \`{{catalog}}\``), but it works differently: a passed value replaces the text, quotes included (`'main'`), and an unpassed one stays in the SQL as written, so `SELECT '{{catalog}}'` runs fine with nothing passed. Whether the run fails depends on where the text is, so it is not a sure failure (tested on a serverless SQL warehouse, CLI v1.25.0, 2026-11-11).

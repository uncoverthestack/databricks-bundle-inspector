# Run targets

`%run` and `dbutils.notebook.run` targets (#233). One task per case in `resources/run_targets.job.yml`, each with its own notebook in `src/jobs/`.

The run results come from deploying this layout to a serverless workspace and running the job (Databricks CLI v1.24.0, 2026-11-06). `bundle validate` passed every case. The `notebook.run` cases ran one after another: the workspace allows 5 active runs, and each `notebook.run` starts one.

| Task | Code in the task's notebook | Run | Inspector |
|---|---|---|---|
| `run_ok` | `%run ./helper_nb` (a notebook) | ok | nothing |
| `run_with_ext` | `%run ./helper_nb.py` | ok | nothing |
| `run_parent` | `%run ../shared/shared_nb` | ok | nothing |
| `run_sql_nb` | `%run ./helper_sql` (a SQL notebook) | ok | nothing |
| `run_ipynb` | `%run ./helper_ipynb` (an `.ipynb` notebook) | ok | nothing |
| `run_missing` | `%run ./missing_helper` | fails: `Notebook not found` | `run_target_not_found` |
| `run_plain_file` | `%run ./helper_plain` (a `.py` file with no notebook header) | fails: `Notebook not found` | `run_target_not_found` |
| `run_folder` | `%run ./somefolder` | fails | `run_target_not_found` |
| `run_gitignored` | `%run ./ignored_nb` (matched by `.gitignore`) | fails: not uploaded | `excluded_from_sync` |
| `nbrun_ok` | `dbutils.notebook.run("./child_nb", 300)` | ok | nothing |
| `nbrun_with_ext` | `dbutils.notebook.run("./child_nb.py", 300)` | ok | nothing |
| `nbrun_parent` | `dbutils.notebook.run("../shared/shared_nb", 300)` | ok | nothing |
| `nbrun_missing` | `dbutils.notebook.run("./missing_child", 300)` | fails: `Unable to access the notebook` | `run_target_not_found` |
| `nbrun_plain_file` | `dbutils.notebook.run("./helper_plain", 300)` | fails: `Unable to access the notebook` | `run_target_not_found` |

Not run, the inspector's own cases: `run_typo` (a close name gets "Did you mean"), `run_quoted` and `run_quoted_missing` (`%run "./path"`, as Databricks' own solution notebooks write it), `nbrun_keyword` (`path=`), and the ones it doesn't check: `run_absolute`, `run_bare`, `run_commented` (a comment and a string), `nbrun_dynamic` (an f-string), `nbrun_other_object` (not `dbutils`).

Test: `src/test/unit/extension/runTargets.test.ts`.

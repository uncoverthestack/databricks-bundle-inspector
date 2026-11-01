# What the inspector checks

[Back to the README](../README.md)

These are the problems the inspector reports. Each one is listed in the Problems panel at the file and line it comes from, and in the graph's issues list. Each has a code, shown next to it in the Problems panel; click the code to open its section here.

Severities: an **error** is likely to fail `bundle deploy` or the job run, a **warning** may fail or behave differently from what you expect, and a **note** is worth a look but often fine.

Most findings are worded as "may": the inspector reads your local files, while the Databricks CLI and the workspace decide at deploy and run time.

**Codes never change.** Once a code has shipped, it is not renamed or removed, so you can rely on it in notes, searches or scripts.

- [Files and paths](#files-and-paths): `missing_file`, `notebook_missing_extension`, `missing_pipeline_source`, `missing_library`, `not_a_notebook`, `file_is_a_notebook`, `excluded_from_sync`, `path_not_checked`
- [`include`](#include): `include_matches_nothing`, `resource_not_included`
- [Jobs](#jobs): `unknown_task_dependency`, `task_dependency_loop`, `duplicate_task_key`, `duplicate_job_parameter`
- [Code in notebooks and files](#code-in-notebooks-and-files): `widget_not_set`, `unused_parameter`, `task_value_unknown_task`, `task_value_not_upstream`, `task_value_key_not_set`, `secret_scope_name_mismatch`
- [Bundle configuration](#bundle-configuration): `missing_bundle_name`, `empty_bundle_name_in_root_path`, `unresolved_variable`, `cli_diagnostic`, `unknown_or_deprecated_field`, `unknown_task_type`, `git_source_not_recommended`

## Files and paths

### `missing_file`

A task points at a local notebook or file that doesn't exist, including the inner task of a `for_each` task.

- **Severity:** error.
- **Example:** `notebook_path: ../src/etl.py`, with no `src/etl.py`.
- **Fix:** create the file, or correct the path. Paths are relative to the YAML file they are written in.
- **Did you mean:** when exactly one file in the bundle has that name and is the kind the field takes, the message names it, written from the YAML file's folder: `File not found: ../notebooks/train.py. Did you mean "../src/train.py"?`. A notebook field only suggests notebooks (with the Databricks header, or Jupyter files); a Python, SQL or other file field only suggests files that aren't notebooks; files left out of the upload aren't suggested. With two or more candidates, none is named, nor in a bundle of more than 20,000 files, where the search stops early. The quick fix quotes the new path when YAML needs it to, for example for `team #2/train.py`.
- **Quick fix:** yes, from the light bulb: **Change to "../src/train.py"**, and **Open "../src/train.py" to the side** to look at it first, without leaving the YAML. Only offered while the file still holds that value, so a path from a variable gets none.
- **Limits:** a path built from a variable isn't checked in the structural preview. Folders and dbt projects get no suggestion.

### `notebook_missing_extension`

A notebook path is written without its extension, and a notebook exists once the extension is added. The Databricks CLI needs the extension for local notebooks.

- **Severity:** error.
- **Example:** `notebook_path: ../src/etl`, with `src/etl.py` on disk.
- **Fix:** add the extension (`.py`, `.r`, `.scala`, `.sql` or `.ipynb`).
- **Quick fix:** yes, from the light bulb: `../src/etl` becomes `../src/etl.py`. It is only offered while the file still holds that value, so a path from a variable gets none.

### `missing_pipeline_source`

A Lakeflow Spark Declarative Pipeline (formerly Delta Live Tables, DLT) lists a notebook or file in `libraries` that doesn't exist, or a `folder/**` glob with no files in it. The CLI doesn't check these during validation, so otherwise they only surface on `bundle deploy`.

- **Severity:** error.
- **Example:** `libraries: [{ glob: { include: ../src/dlt/** } }]` with an empty `src/dlt`.
- **Fix:** add the source files, or correct the path or glob.
- **Did you mean and quick fix:** as for [`missing_file`](#missing_file), for a notebook or file path. Not for a glob.

### `missing_library`

A task installs a local wheel or JAR that isn't there.

- **Severity:** error.
- **Example:** `libraries: [{ whl: ../dist/app-0.1-py3-none-any.whl }]` before the wheel is built.
- **Fix:** build the library, or correct the path.
- **Limits:** a library built by `artifacts` during `bundle deploy` may not exist yet when you edit.

### `not_a_notebook`

A notebook task, or a pipeline `notebook` library, points at a file that the CLI won't treat as a notebook, following the CLI's rules: a `.py`, `.sql`, `.scala` or `.r` file needs the Databricks notebook header as its first line, and a `.ipynb` file must be a Jupyter notebook as the CLI reads it: `cells` a list, `metadata` an object, and `nbformat` a whole number, 4 or more.

- **Severity:** error.
- **Example:** `notebook_path: ../src/query.sql`, where the file has no `-- Databricks notebook source` line.
- **Fix:** add the header line (the warning says which one), or run the file from a task that takes a file, such as `spark_python_task` or `sql_task`.

### `file_is_a_notebook`

A task that takes a plain file (`spark_python_task`, `sql_task`), or a pipeline `file` library, points at a notebook. The CLI treats a file whose first line is the notebook header as a notebook.

- **Severity:** error.
- **Example:** `python_file: ../src/job.py`, where the first line is `# Databricks notebook source`.
- **Fix:** remove the header line, or run it from a notebook task or a pipeline `notebook` library.

### `excluded_from_sync`

A task or pipeline points at a file that `bundle deploy` won't upload: it matches a `.gitignore` rule, a `sync.exclude` pattern, or sits in `.databricks` or `.git`, which are never synced.

- **Severity:** warning.
- **Example:** `notebook_path: ../scripts/report.py`, with `scripts/` in `.gitignore`.
- **Fix:** add the file to `sync.include`, or remove the matching rule. The warning names the rule.
- **Limits:** not checked in bundles that use `sync.paths`, which sync from a different root.

### `path_not_checked`

A task or pipeline path uses a variable, such as `${var.nb_dir}/load.py`, so the structural preview doesn't know which file it is, and none of the checks that read the file ran: missing file, notebook rules, widgets, secrets, task values and files `bundle deploy` would skip. This note says so, so that "not checked" never looks like "no problems".

- **Severity:** note.
- **Example:** `notebook_path: ${var.nb_dir}/load.py`.
- **Fix:** pick a target in the graph. The Databricks CLI then resolves the variable, with its value from the target, overrides or environment, and the file is checked. Nothing needs to change in the bundle.
- **Limits:** the inspector doesn't resolve variables itself, as their values can come from places the preview doesn't see (`BUNDLE_VAR_<name>`, `--var`, `.databricks/bundle/<target>/variable-overrides.json`). Remote paths (`/Workspace/...`, `dbfs:/`) and paths in a job with `git_source` get no note. With `workspace.sync_mode: immutable`, a target's paths point at the snapshot deploy will upload; they are read from the local files as for any other target.

## `include`

The CLI loads only `databricks.yml` and the files its `include` list selects, and says nothing about the rest, so a mistake here just gives the bundle fewer jobs than you expect.

### `include_matches_nothing`

An `include` pattern matches no files, and a likely fix exists: a misspelled folder, or `.yml` where the files end in `.yaml`.

- **Severity:** warning.
- **Example:** `include: [resource/*.yml]`, with the files in `resources/`.
- **Fix:** correct the pattern.
- **Quick fix:** yes, from the light bulb: `resource/*.yml` becomes `resources/*.yml`.
- **Limits:** a pattern with no likely fix isn't reported, as it is often a template default, such as `resources/*.yml` in a bundle whose resources are written in Python.

### `resource_not_included`

A YAML file in the bundle defines resources, but no `include` entry loads it.

- **Severity:** warning.
- **Example:** `resources/jobs/nightly.yml` with `include: [resources/*.yml]`, as `*` doesn't go into subfolders.
- **Fix:** add a pattern that covers the file, such as `resources/**/*.yml`, or delete the file if it's unused.
- **Limits:** a file named in `databricks.yml`, even in a comment, is taken as left out on purpose.

## Jobs

`bundle validate` accepts these. The Databricks Jobs service rejects the first two at `bundle deploy`; the last two deploy, but as a different job from the one written.

### `unknown_task_dependency`

A task's `depends_on` names a task key the job doesn't have.

- **Severity:** error.
- **Example:** `depends_on: [{task_key: laod}]` in a job whose task is `load`. Deploy fails with `Invalid dependency graph for task 'report', job specification does not contain task with key 'laod'`. Keys are case-sensitive: `depends_on: [{task_key: LOAD}]` fails the same way.
- **Fix:** use the `task_key` of a task in the same job. The finding suggests a close match, or names the other job when the key belongs to one: a task can only wait on tasks of its own job.
- **Limits:** checks the job as the CLI resolved it, so with a target picked, tasks the target adds count. A key written with `${var...}` is compared as its value; when a task key can't be resolved offline (for example `${resources...}`), the job's dependencies aren't judged.

### `task_dependency_loop`

Tasks depend on each other in a loop, or a task depends on itself, so none of them can start.

- **Severity:** error.
- **Example:** `x` depends on `y` and `y` on `x`. Deploy fails with `Invalid dependency graph, circular dependencies are not allowed`; a task that depends on itself fails with `task 'a' can not reference itself`.
- **Fix:** remove one of the `depends_on` entries that close the loop. The finding names every task in it and appears on each.
- **Limits:** none known.

### `duplicate_task_key`

One `tasks:` list has two tasks with the same `task_key`. The CLI merges them into one task, later settings overriding earlier ones, so fewer tasks run than are listed.

- **Severity:** warning.
- **Example:** two `- task_key: same` entries, the first with `timeout_seconds: 111`, the second with another notebook. The deployed job has one task `same`, with the timeout from the first and the notebook from the second.
- **Fix:** give each task its own key, or merge them by hand. The finding gives the line of the first.
- **Limits:** a target listing a job's task key again is how a target overrides that task, so only repeats within one list are reported. Keys are compared as the CLI reads them: exactly, so `load` and `Load` are two tasks (both deploy), a number as text (`1` and `"1"` are one task), and with `${var...}` resolved, since the CLI merges after resolving. A repeat inside a target's own list names that target.

### `duplicate_job_parameter`

A job declares the same parameter name twice. The CLI keeps one, with the later default.

- **Severity:** warning.
- **Example:** `parameters: [{name: env, default: "1"}, {name: env, default: "2"}]` deploys one parameter `env` with default `"2"`.
- **Fix:** remove one of them.
- **Limits:** as for `duplicate_task_key`, a target declaring a job's parameter again is an override, not reported.

## Code in notebooks and files

These read the code tasks run. See [Code it reads](#code-it-reads) for which languages and calls are covered.

### `widget_not_set`

A notebook reads a widget that may have no value when it runs as a job: neither the task nor the job passes it, and it has no default. Also reported for a widget created in a cell of the other language (Python and SQL), and for a notebook run with `%run` that reads a widget the `%run` line doesn't pass.

- **Severity:** warning.
- **Example:** `dbutils.widgets.get("run_date")`, with no `run_date` in `base_parameters` or the job's `parameters`.
- **Fix:** pass it in the task's `base_parameters` or the job's `parameters`, or give the widget a default in the notebook. When the name is close to one that is passed, the warning suggests it.

### `unused_parameter`

A task passes a parameter that its notebook never reads as a widget. Often harmless, but it can be a typo or a leftover.

- **Severity:** note.
- **Example:** `base_parameters: { layer: raw }`, and the notebook reads no `layer` widget.
- **Fix:** read it in the notebook, or remove it from `base_parameters`.
- **Limits:** when the notebook reads widgets by names only known at runtime (a name from a variable, `dbutils.widgets.getAll()`, or `dbutils.widgets` passed to other code), the inspector says it didn't check instead, under this code.

### `task_value_unknown_task`

`dbutils.jobs.taskValues.get(...)` or `{{tasks.<task>.values.<key>}}` reads from a task that isn't in the job. Databricks reports this as an error when the job runs.

- **Severity:** warning.
- **Example:** `taskValues.get(taskKey="ingets", key="rows")` in a job whose task is `ingest`.
- **Fix:** use the `task_key` of a task in the same job. When the name is close to one, the warning suggests it.

### `task_value_not_upstream`

A task reads a value from a task that doesn't run before it, so the value may not be set yet.

- **Severity:** warning.
- **Example:** `report` reads from `ingest`, and `ingest` is not in `report`'s `depends_on`, directly or through another task.
- **Fix:** add the task to `depends_on`.

### `task_value_key_not_set`

A task reads a key that the other task's code never sets. Databricks reports a missing key as an error when the job runs.

- **Severity:** warning.
- **Example:** `get(taskKey="ingest", key="row_count")`, while `ingest` only sets `rows`.
- **Fix:** set the key in that task, or read the key it sets.
- **Limits:** only checked when all of that task's code was read, with no `%run` and no key known only at runtime.

### `secret_scope_name_mismatch`

Code reads a secret using a secret scope's resource key from the bundle instead of the scope's name, which fails at runtime.

- **Severity:** warning.
- **Example:** `dbutils.secrets.get(scope="app_secrets", ...)`, where `resources.secret_scopes.app_secrets` has `name: prod-app-secrets`.
- **Fix:** use the scope's `name`.
- **Limits:** a scope with that name that exists outside the bundle is fine.

## Bundle configuration

### `missing_bundle_name`

`databricks.yml` has no `bundle: name:`, so `bundle deploy` fails. The Databricks CLI needs the name to make a target's deploy folder, `.bundle/<name>/<target>`, and stops with "bundle name not defined". An empty `databricks.yml` has the same problem.

- **Severity:** error.
- **Example:** a `databricks.yml` with `targets:` and `resources:`, but no `bundle:`.
- **Fix:** add a name, for example `bundle: name: my_bundle`.
- **Limits:** not reported for a target that sets its own `bundle: name:` or `workspace: root_path:`. The CLI deploys those and only warns that the name is not set. With a target selected, the CLI's own message is shown instead.

### `empty_bundle_name_in_root_path`

`workspace: root_path:` uses `${bundle.name}`, but the bundle has no name, or `name: ""`. The Databricks CLI makes that part of the path empty, so `.bundle/${bundle.name}/${bundle.target}` becomes `.bundle//dev`, which the workspace stores as `.bundle/dev`. Every bundle with no name and the same `root_path` deploys to that one folder. A deploy there can delete the resources another bundle deployed, and the CLI still reports success. With `name: ""` the CLI prints no warning at all.

- **Severity:** warning.
- **Example:** no `bundle: name:`, and `root_path: /Workspace/Users/${workspace.current_user.userName}/.bundle/${bundle.name}/${bundle.target}`.
- **Fix:** add a name, for example `bundle: name: my_bundle`.
- **Limits:** only `${bundle.name}` is checked, not other variables that may be empty. Bundles that share a folder for another reason, or that are deployed from other machines or CI, are not compared. With a target selected it shows in the Problems panel only, not in the graph.

### `unresolved_variable`

A `${var.*}` reference to a variable with no default and no value for the selected target.

- **Severity:** error.
- **Example:** `warehouse_id: ${var.warehouse_id}` with no default, and no value under the target.
- **Fix:** give the variable a default, or a value for the target.
- **Limits:** values from `BUNDLE_VAR_<name>`, `--var` or `.databricks/bundle/<target>/variable-overrides.json` aren't seen in the structural preview.

### `cli_diagnostic`

An error or warning from the Databricks CLI's own `bundle validate`, passed through as the CLI wrote it.

- **Severity:** as the CLI reports it.
- **Fix:** follow the CLI's message.

### `unknown_or_deprecated_field`

The CLI reports a field it doesn't know, or one that is deprecated, for your CLI version.

- **Severity:** as the CLI reports it, usually a warning.
- **Example:** a misspelled field such as `notebok_task`.
- **Fix:** remove or rename the field. A field from a newer CLI version may need a CLI update.

### `unknown_task_type`

A task type the inspector doesn't recognise. It does not mean the task is invalid: the graph shows it without type-specific details.

- **Severity:** note.
- **Fix:** nothing needed. If it is a newer task type, the inspector may not support it yet.

### `git_source_not_recommended`

A task loads its code from Git (`source: GIT`) while its job has no `git_source`.

- **Severity:** error.
- **Fix:** keep the code in the bundle (omit `source`, or use `WORKSPACE`), or add `git_source` to the job.

## Code it reads

Checks on code (secrets, widgets, task values) read **Python and SQL**:

- `.py` and `.sql` files, Jupyter notebooks (`.ipynb`), and Databricks source-format notebooks.
- `%python` and `%sql` cells inside a notebook of the other language, each read in its own language.
- `dbutils` wherever it can be traced: `dbutils` itself (also as `self.dbutils`), a variable assigned from it, `DBUtils(spark)` or `get_dbutils(spark)`, imports under another name, and the Databricks SDK (`WorkspaceClient().dbutils`, `w.secrets.get_secret(...)`). A call on something that can't be traced, such as a function parameter named `d`, isn't counted; a widget read there makes the inspector say it couldn't check that notebook.

**Scala and R are not read.** `.scala` and `.r` notebooks, and `%scala` and `%r` cells, are skipped, so secrets, widgets and task values in them are not found. Markdown cells and other magic cells (`%md`, `%sh`, `%pip`) are not code and are skipped too.

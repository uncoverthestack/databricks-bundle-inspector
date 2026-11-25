# What the inspector checks

[Back to the README](../README.md)

These are the problems the inspector reports. Each one is listed in the Problems panel at the file and line it comes from, and in the graph's issues list. Each has a code, shown next to it in the Problems panel; click the code to open its section here.

Severities: an **error** is likely to fail `bundle deploy` or the job run, a **warning** may fail or behave differently from what you expect, and a **note** is worth a look but often fine.

Most findings are worded as "may": the inspector reads your local files, while the Databricks CLI and the workspace decide at deploy and run time.

**Codes never change.** Once a code has shipped, it is not renamed or removed, so you can rely on it in notes, searches or scripts.

- [Files and paths](#files-and-paths): `missing_file`, `notebook_missing_extension`, `missing_pipeline_source`, `unsupported_pipeline_file`, `missing_library`, `not_a_notebook`, `file_is_a_notebook`, `path_is_a_folder`, `excluded_from_sync`, `path_not_checked`, `same_workspace_path`
- [`include`](#include): `include_matches_nothing`, `resource_not_included`
- [Jobs](#jobs): `unknown_task_dependency`, `task_dependency_loop`, `duplicate_task_key`, `duplicate_job_parameter`, `environment_version_missing`, `unknown_environment_key`, `project_environment_version_missing`, `multiple_job_triggers`, `invalid_job_parameter_name`, `invalid_task_key`, `outcome_without_condition`, `invalid_outcome`, `for_each_inputs_not_array`, `pipeline_selection_not_found`
- [Compute](#compute): `runtime_end_of_support`
- [Code in notebooks and files](#code-in-notebooks-and-files): `widget_not_set`, `unused_parameter`, `sql_parameter_not_set`, `sql_parameter_quoted`, `schema_renamed_in_target`, `task_value_unknown_task`, `task_value_not_upstream`, `task_value_key_not_set`, `secret_scope_name_mismatch`, `run_target_not_found`
- [Bundle configuration](#bundle-configuration): `missing_bundle_name`, `empty_bundle_name_in_root_path`, `unresolved_variable`, `variable_reference_loop`, `internal_resource_set`, `resource_not_defined`, `variable_in_auth_field`, `variable_in_bundle_name`, `invalid_engine`, `terraform_engine_removed`, `terraform_setting_has_no_effect`, `script_no_content`, `variable_in_script_content`, `script_env_reference_not_resolved`, `secret_value_not_variable`, `secret_variable_has_default`, `cli_diagnostic`, `unknown_or_deprecated_field`, `unknown_task_type`, `git_source_not_recommended`

## Files and paths

### `missing_file`

A task points at a local notebook or file that doesn't exist, including the inner task of a `for_each` task.

- **Severity:** error.
- **Example:** `notebook_path: ../src/etl.py`, with no `src/etl.py`.
- **Letter case:** the workspace is case sensitive, so `./Notebooks/Main.py` is not found when the file is `notebooks/main.py`, on every OS. On macOS and Windows, which ignore case, `bundle validate` and deploy pass, and the job fails with "Unable to access the notebook" (checked by deploying, Databricks CLI v1.27.0). Names above the bundle folder aren't compared.
- **Fix:** create the file, or correct the path. Paths are relative to the YAML file they are written in.
- **Did you mean:** when exactly one file in the bundle has the same path apart from letter case, it is named first. Otherwise, when exactly one file in the bundle has that name and is the kind the field takes, the message names it, written from the YAML file's folder: `File not found: ../notebooks/train.py. Did you mean "../src/train.py"?`. A notebook field only suggests notebooks (with the Databricks header, or Jupyter files); a Python, SQL or other file field only suggests files that aren't notebooks; files left out of the upload aren't suggested. With two or more candidates, none is named, nor in a bundle of more than 20,000 files, where the search stops early. The quick fix quotes the new path when YAML needs it to, for example for `team #2/train.py`.
- **Quick fix:** yes, from the light bulb: **Change to "../src/train.py"**, and **Open "../src/train.py" to the side** to look at it first, without leaving the YAML. Only offered while the file still holds that value, so a path from a variable gets none.
- **Limits:** a path built from a variable isn't checked in the structural preview. Folders and dbt projects get no suggestion.

### `notebook_missing_extension`

A notebook path is written without its extension, and a notebook exists once the extension is added. The Databricks CLI needs the extension for local notebooks.

- **Severity:** error.
- **Example:** `notebook_path: ../src/etl`, with `src/etl.py` on disk.
- **Fix:** add the extension (`.py`, `.r`, `.scala`, `.sql` or `.ipynb`).
- **Quick fix:** yes, from the light bulb: `../src/etl` becomes `../src/etl.py`. It is only offered while the file still holds that value, so a path from a variable gets none.
- **Letter case:** the file is found whatever the letter case, and the suggestion uses the case on disk, as the workspace is case sensitive: `./Notebooks/Main` for `notebooks/main.py` suggests `./notebooks/main.py`, on every OS.

### `missing_pipeline_source`

A Lakeflow Spark Declarative Pipeline (formerly Delta Live Tables, DLT) lists a notebook or file in `libraries` that doesn't exist, or a `folder/**` glob with no files in it. The CLI doesn't check these during validation, so otherwise they only surface on `bundle deploy`.

- **Severity:** error.
- **Example:** `libraries: [{ glob: { include: ../src/dlt/** } }]` with an empty `src/dlt`.
- **Fix:** add the source files, or correct the path or glob.
- **Did you mean and quick fix:** as for [`missing_file`](#missing_file), for a notebook or file path. Not for a glob.
- **Globs Databricks refuses:** the only wildcard `glob.include` takes is a trailing `/**`. A single `*` (`../src/dlt/*`, `../src/dlt/*.sql`, `../src/dlt/**/*.sql`) fails deploy with "Single asterisk glob pattern is not supported", and `*` or `?` anywhere else with "Special characters *?\ are reserved". `bundle validate` passes them (checked by deploying, Databricks CLI v1.27.0). The finding says `Did you mean "../src/dlt/**"?` when the wildcard is only in the last part of the path, with a quick fix.

### `unsupported_pipeline_file`

A pipeline glob (`folder/**`) takes every file deploy uploads under its folder, hidden files included, and the pipeline update fails on some of them, even next to valid sources: `[UNSUPPORTED_LIBRARY_FILE_TYPE] The file at .../src/dlt/.gitkeep does not have .py or .sql suffix`. `bundle validate` and deploy pass.

- **Severity:** error.
- **Which files:** checked by deploying and running, Databricks CLI v1.27.0, each next to a valid `.sql` file. `.py` and `.sql` are sources, and `.md`, `.txt`, `.csv`, `.json` and `.ipynb` were skipped. Every other type tested failed: no extension (`.gitkeep`, `.DS_Store`, `.env`, `.gitignore`, `Makefile`), `.yml`, `.yaml`, `.toml`, `.cfg`, `.ini`, `.lock`, `.whl`, `.png`, `.html`, `.sh`, `.java`, `.r` and `.scala`, so any type not in the first two lists gets the finding. A file in a subfolder counts too.
- **Example:** `include: ../src/dlt/**` with a `.gitkeep` or a `.DS_Store` in `src/dlt`: `Add "src/dlt/.gitkeep" to sync.exclude: deployed under "../src/dlt/**", it may fail the pipeline, which only takes .py and .sql files.`
- **Fix:** add the file to `sync.exclude` or `.gitignore`, or move it out of the folder. A file left out of the upload gets no finding.

### `missing_library`

A task installs a local wheel or JAR that isn't there, or a job environment lists a local file in `dependencies` that isn't there. `bundle validate` passes; deploy fails with "file doesn't exist" (checked by deploying, Databricks CLI v1.27.0).

- **Severity:** error.
- **Example:** `libraries: [{ whl: ../dist/app-0.1-py3-none-any.whl }]` with no such file, or `dependencies: [./dist/app-0.1-py3-none-any.whl]` in `resources/job.yml`, which is read as `resources/dist/...`: `Did you mean "../dist/app-0.1-py3-none-any.whl"?`
- **Globs:** deploy expands a `whl` or `jar` glob such as `../dist/*.whl`, in a task's libraries and in environment dependencies, and fails only when no file matches it ("no files match pattern"). The finding says "no file matches". An `egg` glob isn't expanded by the CLI.
- **Built at deploy:** deploy builds artifacts before it checks these files, so no finding is shown for a file deploy may build: in an artifact's `files` folder, in `<path>/dist` for a `whl` artifact, in `dist` when there are no `artifacts` and a `setup.py` in the bundle root, or anywhere when an `experimental.scripts` build hook (`preinit`, `prebuild`, `postbuild`) or an artifact with a `build` and no `files` is set.
- **Fix:** build the library, or correct the path. Paths are relative to the YAML file they are written in.
- **Not checked:** `-r` and `-e` paths (a missing requirements file already fails `bundle validate`), cluster libraries and pipeline environment dependencies.

### `not_a_notebook`

A notebook task, or a pipeline `notebook` library, points at a file that the CLI won't treat as a notebook, following the CLI's rules for a `.py`, `.sql`, `.scala` or `.r` file, which depend on the CLI version:

- **Databricks CLI v1.24.0 and later:** the first line must contain `Databricks notebook source`, within the first 200 bytes of the file.
- **Before v1.24.0:** the first line must be exactly the header for the file type, such as `# Databricks notebook source` for `.py`. An invisible byte order mark at the start of the file, or other text on that line, makes it a plain file.

The inspector uses the rules of the CLI that validated the bundle, and the newer ones when it can't read the version. A `.ipynb` file must be a Jupyter notebook as the CLI reads it: `cells` a list, `metadata` an object, and `nbformat` a whole number, 4 or more.

- **Severity:** error.
- **Example:** `notebook_path: ../src/query.sql`, where the file has no `-- Databricks notebook source` line.
- **Fix:** add the header line (the warning says which one), or run the file from a task that takes a file, such as `spark_python_task` or `sql_task`.

### `file_is_a_notebook`

A task that takes a plain file (`spark_python_task`, `sql_task`), or a pipeline `file` library, points at a notebook. The CLI treats a file whose first line is the notebook header as a notebook. From Databricks CLI v1.24.0, a first line that only contains `Databricks notebook source` is enough, so a file with a byte order mark or other text on that line is a notebook too (see [`not_a_notebook`](#not_a_notebook)).

- **Severity:** error.
- **Example:** `python_file: ../src/job.py`, where the first line is `# Databricks notebook source`.
- **Fix:** remove the header line, or run it from a notebook task or a pipeline `notebook` library.

### `path_is_a_folder`

A task path that takes a notebook or a file, or a pipeline `notebook` or `file` library, points at a folder. With a target, the CLI turns it down while reading the first line (Databricks CLI v1.27.0, `translate_paths.go`): `unable to determine if <path> is a notebook: ... is a directory`. The structural preview never gets that far, so `bundle validate` without a target passes.

- **Severity:** error.
- **Example:** `notebook_path: ./etl.py`, where `etl.py` is a folder.
- **Fix:** point it at a notebook or file inside the folder. A pipeline that should load a whole folder takes a `glob` library instead.

### `excluded_from_sync`

A task or pipeline points at a file that `bundle deploy` won't upload: it matches a `.gitignore` rule, a `sync.exclude` pattern, or sits in `.databricks` or `.git`, which are never synced. A `%run` or `dbutils.notebook.run` target gets it too.

A symbolic link isn't uploaded either, whether it is the file or a folder above it: the Databricks CLI skips links, and `sync.include` doesn't bring them back. Checked by deploying a bundle (Databricks CLI v1.24.0): a task on a linked notebook, and a `%run` of one, deploy and then fail when the job runs, with "Unable to access the notebook" and "Notebook not found". A link above the bundle folder, or the bundle folder itself, is fine.

A pipeline glob (`folder/**`) gets it too when every file in its folder is left out. Nothing is uploaded, so the folder isn't in the workspace, and the pipeline update fails with `LIBRARY_FILE_NOT_FOUND` (checked by deploying and running, Databricks CLI v1.27.0). One file uploaded is enough for no warning, hidden files included: deploy uploads a `.gitignore` or `.gitkeep` in the folder too.

- **Severity:** warning.
- **Example:** `notebook_path: ../scripts/report.py`, with `scripts/` in `.gitignore`. For a glob: `include: ../src/dlt/**` with `*.sql` in `.gitignore`, which says `Add "src/dlt/**" to sync.include`, a pattern written from the bundle root as `sync.include` reads it.
- **Fix:** add the file to `sync.include`, or remove the matching rule. The warning names the rule. For a symbolic link, point the path at the real file, or replace the link with a copy.
- **Limits:** not checked when `sync.paths` reaches outside the bundle folder, which makes the Databricks CLI sync from a different root. The default, `sync.paths: ["."]`, is checked.

### `path_not_checked`

A task or pipeline path uses a variable, such as `${var.nb_dir}/load.py`, so the structural preview doesn't know which file it is, and none of the checks that read the file ran: missing file, notebook rules, widgets, secrets, task values and files `bundle deploy` would skip. This note says so, so that "not checked" never looks like "no problems".

- **Severity:** note.
- **Example:** `notebook_path: ${var.nb_dir}/load.py`.
- **Fix:** pick a target in the graph. The Databricks CLI then resolves the variable, with its value from the target, overrides or environment, and the file is checked. Nothing needs to change in the bundle.
- **Limits:** the inspector doesn't resolve variables itself, as their values can come from places the preview doesn't see (`BUNDLE_VAR_<name>`, `--var`, `.databricks/bundle/<target>/variable-overrides.json`). Remote paths (`/Workspace/...`, `dbfs:/`) and paths in a job with `git_source` get no note. With `workspace.sync_mode: immutable`, a target's paths point at the snapshot deploy will upload; they are read from the local files as for any other target.

### `same_workspace_path`

Two files `bundle deploy` uploads get the same workspace path, because a notebook loses its file extension when deployed: `src/dup.py` and `src/dup.sql` both become `src/dup`. `bundle validate` passes, and `bundle deploy` stops with "both src/dup.py and src/dup.sql point to the same remote file location src/dup". A notebook whose workspace path is also a folder, such as `src/foo.py` next to a folder `src/foo/`, stops the deploy with "type mismatch (asked: NOTEBOOK, actual: DIRECTORY)".

Checked by deploying one bundle per case (Databricks CLI v1.24.0). These fail: two notebooks with one name (`.py` and `.sql`, `.py` and `.ipynb`, also with an upper-case extension such as `.PY`), a notebook and a plain file with no extension (`foo.py` and `foo`), a notebook and a folder, and each of them with `sync_mode: immutable`. These deploy, and get no finding: a pair where `.gitignore` or `sync.exclude` leaves one file out, names that differ only in upper and lower case (`dup.py` and `Dup.sql`), and a plain `.py` file without the notebook header next to a notebook `.sql`.

- **Severity:** error.
- **Example:** `src/load.py` and `src/load.sql`, both starting with the Databricks notebook header.
- **Fix:** rename or remove one of the files, or leave one out of the deploy with `sync.exclude`.
- **Limits:** not checked when `sync.paths` is set, as the inspector doesn't follow a different sync root (see [`excluded_from_sync`](#excluded_from_sync)). Folders the inspector never reads, such as `node_modules` and `.venv`, aren't checked.

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

`bundle validate` accepts these. The Databricks Jobs service rejects the dependency, environment and job setting mistakes at `bundle deploy`, except `project_environment_version_missing`, which deploys and fails when the job runs. The duplicates deploy, but as a different job from the one written. The job setting checks (`multiple_job_triggers` to `for_each_inputs_not_array`) were each deployed broken and working with Databricks CLI v1.28.0 on 2026-11-25, two runs each.

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

### `environment_version_missing`

A job environment (`environments[].spec`) sets none of `environment_version`, `client`, `base_environment` or `project_environment`, for example only `dependencies`, an empty `spec`, or no `spec` at all.

- **Severity:** error.
- **Example:** `environments: [{environment_key: e, spec: {dependencies: [simplejson]}}]`. Deploy fails with `Either base environment, version, or project_environment must be provided for environment 'e'`, after the bundle's files are uploaded.
- **Fix:** set `environment_version` (for example `"5"`), `base_environment` or `project_environment` in the spec.
- **Limits:** checks the job as the CLI resolved it, so a target's settings count. A value from a variable counts as set. Tested 2026-11-12 on Databricks CLI v1.26.0: `client` (the older field) deploys and runs. A CLI older than v1.20.0 doesn't know `project_environment` and drops it with an "unknown field" warning; the environment is then not reported here, since the YAML does set a version.

### `unknown_environment_key`

A task's `environment_key` names an environment the job doesn't have.

- **Severity:** error.
- **Example:** `environment_key: defualt` in a job whose environment is `default`. Deploy fails with `Job environment 'defualt' used by task script is not defined in field 'environments'`.
- **Fix:** use the `environment_key` of one of the job's environments. The finding suggests a close match.
- **Limits:** a for-each task's inner task is checked too. When an environment key can't be resolved offline, the job's tasks aren't judged.

### `project_environment_version_missing`

A job environment's `project_environment` names a `pyproject.toml` that has neither `environment_version` nor `base_environment`.

- **Severity:** error.
- **Example:** a `pyproject.toml` with only `[project]` and its `dependencies`. Validate and deploy pass; the job run fails with `pyproject.toml must specify environment_version or base_environment under [tool.databricks.environment]`.
- **Fix:** add the version to the file:

  ```toml
  [tool.databricks.environment]
  environment_version = "5"
  ```

- **Limits:** the local file is read. Any line outside a comment that sets `environment_version` or `base_environment` counts, whichever way the TOML writes the table, so a key set in another table is not reported. A path from an unresolved variable, or a file that isn't there, is not checked.

### `multiple_job_triggers`

A job sets more than one of `schedule`, `trigger` and `continuous`.

- **Severity:** error.
- **Example:** a job with a `schedule` and a `trigger.periodic`. Deploy fails with `Invalid trigger settings. One of 'schedule', 'trigger' or 'continuous' can be set.` An empty `schedule: {}` counts as set; `schedule:` with no value does not, and deploys.
- **Fix:** keep only one of them.
- **Limits:** checks the job as the CLI resolved it, so a trigger a target adds counts, and the finding points at it. A trigger from a variable the preview can't resolve is not counted.

### `invalid_job_parameter_name`

A job parameter's `name` has a character other than a letter, a digit, `-`, `_` or `.`.

- **Severity:** error.
- **Example:** `name: bad name`. Deploy fails with `The specified parameter name contains an invalid character, only alphanumeric, -, _ and . characters are permitted.` Letters are A to Z only: `café` fails too. A name starting with a dot, such as `.a`, deploys.
- **Fix:** rename the parameter, and the `{{job.parameters.…}}` references to it.
- **Limits:** a name from a variable is checked once it resolves.

### `invalid_task_key`

A `task_key` has a character other than a letter, a digit, `-` or `_`.

- **Severity:** error.
- **Example:** `task_key: "load "`, with a trailing space. Deploy fails with `Task key 'load ' contains an invalid character. Only alphanumeric, - and _ characters are permitted.` Dots and accented letters (`café`) fail too; keys that differ only in letter case (`load`, `Load`) are two tasks and deploy.
- **Fix:** rename the task, and the `depends_on` entries that name it.
- **Limits:** a for-each task's inner task is checked too. A key from a variable is checked once it resolves.

### `outcome_without_condition`

A `depends_on` entry sets `outcome` on a task that is not an if/else condition task.

- **Severity:** error.
- **Example:** `depends_on: [{task_key: load, outcome: "true"}]` where `load` is a notebook task. Deploy fails with `The dependency on a non-if/else condition "load" specifies an outcome "true". Outcomes can only be specified for if/else condition dependencies.`
- **Fix:** remove the `outcome`, or depend on a `condition_task`.
- **Limits:** a dependency on a task the job doesn't have is `unknown_task_dependency` instead. An outcome from an unresolved variable is not judged.

### `invalid_outcome`

A dependency on an if/else condition task sets an `outcome` other than `"true"` or `"false"`.

- **Severity:** error.
- **Example:** `outcome: "True"`. Deploy fails with `The dependency on task "check" specifies invalid outcome "True". Valid values are "true" and "false"`. Unquoted `outcome: true` deploys: the CLI reads it as `"true"`.
- **Fix:** use `"true"` or `"false"`, in lower case.

### `for_each_inputs_not_array`

A `for_each_task`'s `inputs` is not a JSON array deploy accepts.

- **Severity:** error.
- **Example:** `inputs: '{"a": 1}'`. Deploy fails with `The JSON string in the inputs field should be an array of primitives or objects.` Deploy takes an array of plain values (strings, numbers, true or false, mixed freely) or an array of objects. Text that isn't JSON, a JSON object, a list inside the list (`[[1, 2]]`), a `null` item, and plain values mixed with objects (`["a", {"k": "v"}]`) all fail. `[]` deploys.
- **Fix:** write a JSON array of plain values or of objects.
- **Limits:** inputs with `{{job.parameters.…}}`, `{{tasks.….values.…}}` or an unresolved variable are filled in later and not judged.

### `pipeline_selection_not_found`

A pipeline task refreshes a table or flow its pipeline doesn't create.

- **Severity:** warning.
- **Example:** `refresh_selection: [orders_silvr]` in a task that runs a pipeline whose SQL creates `orders_silver`. `bundle validate` and `bundle deploy` accept it; the run fails with `INVALID_REFRESH_SELECTION.TABLE_NOT_FOUND` (or `FLOW_NOT_FOUND` for `refresh_flow_selection`). Letter case counts: `ORDERS_SILVER` fails the same way. Only the pipeline's own tables count: a table in the same schema made by another pipeline, or one this pipeline no longer defines but which is still in the catalog, fails too. Checked live with CLI v1.27.0 on 2026-11-24, two runs each. By default a production pipeline retries a failed update 5 times, about 11 minutes in that test, before the task fails; `pipelines.numUpdateRetryAttempts` in the pipeline's `configuration` changes that.
- **Fix:** use the name of a table, view or flow the pipeline creates, as written in its SQL. A full name, `catalog.schema.table`, works when its catalog and schema are the pipeline's. The finding suggests a close match.
- **Checked fields:** `refresh_selection`, `full_refresh_selection` and `refresh_flow_selection`, also in a `for_each_task`'s inner task. Not `reset_checkpoint_selection` yet.
- **Limits:** checked only when the pipeline's data flow lists every name: every source is a local SQL file the inspector read, with no name it could not read. A pipeline with Python sources, a source it doesn't check, a selection written as a variable, or a full name when the pipeline's catalog or schema is a variable, is not judged.

## Compute

### `runtime_end_of_support`

A cluster's `spark_version` is a Databricks Runtime near or past its end of support.

- **Severity:** note when end of support is within a year, warning once it has passed, or for 10.4 LTS and earlier, which Databricks lists as past end of life.
- **Example:** `spark_version: 13.3.x-scala2.12`. Databricks Runtime 13.3 LTS reached end of support on 2026-08-22. `bundle validate` and `bundle deploy` don't read the version, and the cluster still starts: a job cluster on 12.2 LTS, past end of support since 2026-03-01, ran in a live test with CLI v1.27.0 on 2026-11-23. Databricks no longer fixes the version, security included. At end of life Databricks removes a version and workloads on it fail; it has announced no end-of-life date for 10.5 or later.
- **Fix:** move to a supported long-term support (LTS) version, such as the newest one the finding names.
- **Checked fields:** `spark_version` in `resources.clusters`, in a job's `job_clusters`, and in a task's `new_cluster`, also a `for_each_task`'s inner task. Photon, ML and GPU versions count as the version they are based on. A value from a variable counts once it resolves.
- **Limits:** the dates come from the [Databricks Runtime release notes](https://docs.databricks.com/aws/en/release-notes/runtime/) and the [end-of-support list](https://docs.databricks.com/aws/en/release-notes/runtime/eos), read 2026-11-24, and ship with the extension. A weekly check compares them with those pages, so a new version or date reaches the next release; a newer version than your copy of the extension knows isn't judged. `existing_cluster_id`, a version set only by a cluster policy, and pipelines (which use `channel`) aren't checked.

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

### `sql_parameter_not_set`

A SQL file run by a SQL file task (`sql_task.file`) uses a parameter that neither the task's `sql_task.parameters` nor the job's `parameters` pass. `bundle validate` and `bundle deploy` succeed. What happens at run time depends on how the parameter is written:

- **`:name`** (a named parameter marker): the run fails with `UNBOUND_SQL_PARAMETER`.
- **`{{name}}` inside quotes**, such as `WHERE d = '{{run_date}}'`: the placeholder is left as written, so the query runs on the text `{{run_date}}`. It can succeed with wrong results and no error.
- **`{{name}}` outside quotes**, such as `FROM {{table_name}}`: the run fails with `PARSE_SYNTAX_ERROR`.

- **Severity:** warning.
- **Example:** `FROM IDENTIFIER(:catalog || '.sales.orders')`, or `WHERE d = '{{run_date}}'`, with no `catalog` or `run_date` in the task's `parameters` or the job's `parameters`.
- **Fix:** pass it in the task's `sql_task.parameters` or the job's `parameters`. When the name is close to one that is passed, the warning suggests it.
- **Limits:**
  - `:name`: only markers in code are read, not `::` casts, JSON paths (`raw:owner`), comments or strings.
  - `{{name}}`: only the form with a plain name and no spaces. `{{ name }}` and dotted names such as `{{job.start_time}}` are not checked. Comments are not read.
  - Names are case sensitive: `:Catalog` and `{{Catalog}}` are not filled by `catalog`.
  - Legacy `${name}` text is not checked. A parameter the task passes but the file doesn't read is fine and not reported. SQL files from Git are not read.
  - Tested on a serverless SQL warehouse: `:name` with CLI v1.24.0 (2026-11-06); `{{name}}` with CLI v1.27.0 (2026-11-24, issue 484).

### `sql_parameter_quoted`

A SQL file run by a SQL file task puts a `{{name}}` parameter that the task or job passes inside quotes, such as `WHERE region = '{{region}}'`. Databricks fills `{{name}}` in with the value already quoted, so the query becomes `WHERE region = ''emea''` and the run fails with `PARSE_SYNTAX_ERROR`. `bundle validate` and `bundle deploy` succeed.

- **Severity:** warning.
- **Example:** `SELECT '{{run_date}}'`, with `run_date` in the task's `sql_task.parameters`.
- **Fix:** write `{{region}}` without quotes: `WHERE region = {{region}}`.
- **Limits:** only when the quotes hold nothing but the parameter. A parameter inside a longer string, such as `LIKE '%{{name}}%'`, was not tested and is not reported. Tested on a serverless SQL warehouse, CLI v1.27.0 (2026-11-24, issue 484).

### `schema_renamed_in_target`

Task code or a task's parameters write the name of a schema this bundle defines, and a target deploys that schema under another name. The CLI adds the target's name prefix to every bundle schema: development mode makes `sales` into `dev_<you>_sales`, and `presets.name_prefix` adds its own prefix. Only `${resources.schemas.<key>.name}` follows the rename, so a written name points at a schema that may not exist in that target: deploy succeeds and the run fails with `SCHEMA_NOT_FOUND`. Or it may be a different schema with the same name: when another target, such as production, has already deployed the unprefixed name, a development run reads and writes that schema instead of its own.

- **Severity:** warning.
- **Example:** `spark.table("workspace.sales.orders")` or `base_parameters: { schema: sales }`, with `resources.schemas.x.name: sales` and a `mode: development` target.
- **Fix:** pass `${resources.schemas.<key>.name}` to the task as a parameter and read it in the code, or use it in place of the written name in YAML.
- **Limits:**
  - Checked on the structural preview, where names are still as written. With a target picked, the CLI has already renamed the schemas, so the check doesn't run.
  - In code, a name counts when it is one part of a dotted name, such as `workspace.sales` or `sales.orders`, in SQL code, SQL strings and Python strings. Comments don't count, and neither does a name on its own.
  - In YAML, task parameter values and job parameter defaults are read. Other places, such as a Python task's command-line `parameters`, are not.
  - Not reported when `experimental.skip_name_prefix_for_schema` is set, or when the schema's name is a variable.

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

Code reads a secret using a secret scope's resource key from the bundle instead of the scope's name, which may fail at runtime.

- **Severity:** warning.
- **Example:** `dbutils.secrets.get(scope="app_secrets", ...)`, where `resources.secret_scopes.app_secrets` has `name: prod-app-secrets`.
- **Checked calls:** `dbutils.secrets.get`, `getBytes` and `list` in Python, the SDK's `secrets.get_secret`, `secret()` and `try_secret()` in SQL, and `{{secrets/<scope>/<key>}}` in cluster settings. Also a scope the code reads from a notebook parameter, by that parameter's value in the bundle: a job parameter's over the task's own.
- **Fix:** use the scope's `name`.
- **Limits:** a scope with that name that exists outside the bundle is fine.

### `run_target_not_found`

A notebook task's notebook runs another notebook with `%run` or `dbutils.notebook.run`, and the path doesn't lead to a notebook the bundle deploys. `bundle validate` and deploy pass, and the job fails when it runs: `Notebook not found` for `%run`, `Unable to access the notebook` for `notebook.run`.

Checked by running a job on a serverless workspace (Databricks CLI v1.24.0), one task per case. A notebook runs with or without its extension in the path (`./helper` or `./helper.py`), from `./` or `../`, including a SQL or `.ipynb` notebook. These fail, and each gets this finding:

- nothing at the path (with a "Did you mean" when a notebook in that folder has a close name);
- a plain file without the Databricks notebook header, which deploys as a file;
- a folder;
- a path whose upper and lower case don't match the file's (`./Helper` for `helper.py`): the workspace tells them apart, even on a computer whose disk doesn't.

A notebook that exists but that `bundle deploy` doesn't upload, for example because `.gitignore` matches it, gets [`excluded_from_sync`](#excluded_from_sync) instead.

- **Severity:** error.
- **Example:** `%run ./shared/helpers`, with no `shared/helpers.py` (or `.sql`, `.scala`, `.r`, `.ipynb`) next to the notebook.
- **Fix:** point it at a notebook in the bundle, with a relative path (`./name` or `../folder/name`).
- **Limits:** only paths written out as relative paths are checked, with or without quotes (`%run "./helper"`). Absolute workspace paths (`/Workspace/...`), bare names, and paths built at run time (`dbutils.notebook.run(name, ...)`, f-strings) aren't. Only the task's own notebook is checked, not notebooks it pulls in with `%run`, whose own paths may resolve from the calling notebook's folder. Jobs with a `git_source` aren't checked.

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

### `variable_reference_loop`

Variable values refer to each other in a loop, or a variable refers to itself, so the Databricks CLI can never work out their values. It fails a target even when nothing uses the variables. The inspector follows each `${var.*}` in the defaults and in each target's overrides, field by field, as the CLI does: `a.x: ${var.b}` with `b: ${var.a.x}` is a loop, while `a.y: ${var.b}` with `b: ${var.a.x}` is not when `a.x` is a plain value.

- **Severity:** error. A warning when the loop passes through a whole complex value (`${var.a}` where `a` is a mapping or list): the CLI then stops after 11 rounds with `Variables references are too deep` instead of failing, and the `${var.*}` text may stay in what it deploys.
- **Example:** `catalog: ${var.env_catalog}` and `env_catalog: ${var.catalog}`. `bundle validate` and deploy fail with `cycle detected in field resolution: variables.catalog.default -> var.env_catalog -> var.catalog -> var.env_catalog` (CLI v1.24.0). The finding names every variable in the loop, appears at each one's value, and says which targets fail: a target's override can make a loop, or break one.
- **Fix:** give one of the variables in the loop a value that doesn't refer back.
- **Limits:** reported in the structural preview only; with a target picked, the CLI's own error shows. A `BUNDLE_VAR_<name>` environment variable, `--var` or `variable-overrides.json` can set one of the variables and break the loop, which the inspector doesn't see.

### `internal_resource_set`

The bundle sets a resource group the Databricks CLI only writes for itself, such as `internal_immutable_snapshots`. `bundle validate` and deploy stop with "Internal resources cannot be set in bundle configuration".

- **Severity:** error.
- **Example:** `resources: internal_immutable_snapshots: { immutable: { bundle_id: 123 } }`.
- **Fix:** remove the group.
- **Limits:** Databricks CLI v1.16.0 and later. An older CLI doesn't know these groups: it warns "unknown field" and drops them. Like every check from here to `secret_variable_has_default`, it comes from a check the CLI only runs once it has picked a target, so the structural preview, which validates with no real target, never sees the CLI's own message. With a target picked, the CLI's message shows instead.

### `resource_not_defined`

A resource key has nothing under it, so `bundle validate` and deploy stop with "job nightly is not defined" (or pipeline, and so on).

- **Severity:** error.
- **Example:** `resources: jobs: nightly:` with nothing after `nightly:`, often a half-written resource.
- **Fix:** add the resource's settings under the key, or remove the key.
- **Limits:** only resources the bundle itself defines; a target that overrides a resource with nothing is not checked.

### `variable_in_auth_field`

A workspace setting that configures sign-in, such as `workspace.host` or `workspace.profile`, uses `${...}`. The CLI reads these before it resolves variables, so it warns "Variable interpolation is not supported for fields that configure authentication", and then tries the text as written, for example `https://${var.host}`.

- **Severity:** warning.
- **Example:** `workspace: host: ${var.host}`, in the bundle or in a target.
- **Fix:** write the value itself, or leave the field out and set its environment variable, such as `DATABRICKS_HOST`.
- **Limits:** the fields the CLI checks: `host`, `profile`, `auth_type`, `metadata_service_url`, `client_id`, `google_service_account`, the `azure_*` fields, `account_id` and `workspace_id`.

### `variable_in_bundle_name`

`bundle.name` uses `${...}`. The name is part of the folder each deploy keeps its state in, so a name that changes can deploy the same bundle twice, or leave resources behind on `bundle destroy`. The CLI warns "Please do not use variable interpolation in the name of your bundle".

- **Severity:** warning.
- **Example:** `bundle: name: ${var.name}`.
- **Fix:** write the name itself.

### `invalid_engine`

`bundle.engine` is set to something the CLI doesn't know, so `bundle validate` and deploy stop with `invalid value "drect" for bundle.engine`.

- **Severity:** error.
- **Example:** `bundle: engine: drect`.
- **Fix:** use `direct`, or leave `bundle.engine` out. Before Databricks CLI v1.20.0, `terraform` is valid too.

### `terraform_engine_removed`

`bundle.engine` is `terraform`, which Databricks CLI v1.20.0 removed. `bundle validate` and deploy stop with "the Terraform deployment engine has been removed in Databricks CLI v1.20.0".

- **Severity:** error.
- **Example:** `bundle: engine: terraform`, in the bundle or in a target.
- **Fix:** change it to `direct`, or leave `bundle.engine` out. A bundle deployed with Terraform may need migrating first; see the Databricks CLI release notes for v1.20.0.
- **Limits:** Databricks CLI v1.20.0 and later, and when the CLI's version can't be read. Older CLIs deploy with Terraform.

### `terraform_setting_has_no_effect`

`bundle.terraform` is set, which does nothing since Databricks CLI v1.20.0 removed the Terraform engine. The CLI warns "bundle.terraform is deprecated and has no effect".

- **Severity:** warning.
- **Example:** `bundle: terraform: { exec_path: /usr/local/bin/terraform }`.
- **Fix:** remove `bundle.terraform`.
- **Limits:** Databricks CLI v1.20.0 and later, and when the CLI's version can't be read.

### `script_no_content`

A script under `scripts:` has no `content`, so `bundle validate` and deploy stop with "Script hello has no content".

- **Severity:** error.
- **Example:** `scripts: hello: { content: "" }`.
- **Fix:** add the commands to run under `content:`, or remove the script.

### `variable_in_script_content`

A script's `content` uses `${...}`, which the CLI doesn't allow there, because the shell has its own `${...}`. `bundle validate` and deploy stop with "Found ${bundle.name} in script hello.content".

- **Severity:** error.
- **Example:** `scripts: hello: { content: echo ${bundle.name} }`.
- **Fix:** set the value under the script's `env:`, for example `env: { NAME: ${bundle.name} }`, and use `$NAME` in the content.
- **Limits:** from Databricks CLI v1.15.0, `$${...}` is an escaped literal and fine. An older CLI still reads `$${HOME}` as `${HOME}` and rejects it, and so does this check.

### `script_env_reference_not_resolved`

A script's `env:` uses a value the CLI hasn't worked out when scripts run, such as `${resources.jobs.nightly.id}`. Only `${bundle.*}`, `${workspace.*}` and `${var.*}` are. `bundle validate` and deploy stop with "cannot be used in scripts.hello.env.JOB_ID".

- **Severity:** error.
- **Example:** `env: { JOB_ID: ${resources.jobs.nightly.id} }`.
- **Fix:** use a `bundle`, `workspace` or `var` value, or read the ID in the script itself.
- **Limits:** Databricks CLI v1.8.0 and later. An older CLI doesn't know `env:` in a script: it warns "unknown field" and drops it.

### `secret_value_not_variable`

A secret under `resources: secrets:` has its value written in the file, a value that isn't text, or no value. The CLI only accepts a variable reference, so the secret is never stored in plain text, and stops with "Secret value must be a variable reference" or "Secret value must be a string".

- **Severity:** error.
- **Example:** `value: my-api-key`, or no `value:` at all.
- **Fix:** use `value: ${var.my_secret}` with a variable that has no default, and pass it at deploy with `--var` or `BUNDLE_VAR_my_secret`.
- **Limits:** Databricks CLI v1.12.0 and later. An older CLI doesn't know secrets: it warns "unknown field" and drops them. The CLI hides secret values in its output, so the value is read from the YAML as written, in the bundle and in each target.

### `secret_variable_has_default`

A secret's value is a variable that has a value in the bundle, a `default` or a target's value. That value is in the file as plain text, so the CLI stops with "Variable used for secret value must not have a default value".

- **Severity:** error.
- **Example:** `value: ${var.api_key}` with `variables: api_key: { default: my-api-key }`, or a target that sets `api_key`.
- **Fix:** remove the default and any target's value, and pass the variable at deploy with `--var` or `BUNDLE_VAR_api_key`.
- **Limits:** Databricks CLI v1.12.0 and later, as for `secret_value_not_variable`.

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

A task's `source` doesn't fit its job's `git_source`, so `bundle validate` passes and deploy refuses the task. Two cases:

- **`source: GIT` in a job with no `git_source`.** Deploy fails with "source is set to GIT but no git_source settings are provided". This often happens after removing `git_source` from a job. The path is still checked as a local file, as the CLI reads it.
- **`source: WORKSPACE` with a relative path in a job with `git_source`.** The CLI rewrites no task path in such a job, so `../src/etl.py` reaches Databricks as written. Deploy fails with "Only absolute paths are currently supported" (notebook and SQL file tasks) or "Relative paths are only supported when source is set to GIT" (Python file tasks), even when the file is on disk (checked by deploying, Databricks CLI v1.27.0). A path from a variable is left alone, as it may resolve to a `/Workspace` path.

- **Severity:** error.
- **Fix:** for `source: GIT`, keep the code in the bundle (omit `source`, or use `WORKSPACE`), or add `git_source` to the job. For `source: WORKSPACE`, use a path from `/Workspace`, or remove `source: WORKSPACE` to read the path from the job's Git repository.

## Code it reads

Checks on code (secrets, widgets, task values) read **Python and SQL**:

- `.py` and `.sql` files, Jupyter notebooks (`.ipynb`), and Databricks source-format notebooks.
- `%python` and `%sql` cells inside a notebook of the other language, each read in its own language.
- `dbutils` wherever it can be traced: `dbutils` itself (also as `self.dbutils`), a variable assigned from it, `DBUtils(spark)` or `get_dbutils(spark)`, imports under another name, and the Databricks SDK (`WorkspaceClient().dbutils`, `w.secrets.get_secret(...)`). A call on something that can't be traced, such as a function parameter named `d`, isn't counted; a widget read there makes the inspector say it couldn't check that notebook.

**Scala and R are not read.** `.scala` and `.r` notebooks, and `%scala` and `%r` cells, are skipped, so secrets, widgets and task values in them are not found. Markdown cells and other magic cells (`%md`, `%sh`, `%pip`) are not code and are skipped too.

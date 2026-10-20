# Changelog

All notable changes to the **Databricks Bundle Inspector** extension are documented in this file.

## [Unreleased]

### Added

- **Open the graph from a resource file** ([#166](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/166)), not only from `databricks.yml`. Inspect Databricks Bundle now shows on any file the bundle's `include` loads, such as `resources/etl_job.yml`, and the graph opens on the job your cursor is in, or the file's first job. Which files count comes from the Databricks CLI's own list of the files it loaded, so a file `include` doesn't load gets no button.
- **A file that isn't checked because its path uses a variable now says so** ([#174](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/174)). In the structural preview, a task or pipeline path such as `${var.nb_dir}/load.py` stays unresolved, so none of the checks that read the file ran, and nothing said so. It now gets a note, `path_not_checked`, at the path's line: "Not checked: ... Pick a target in the graph to check it." The graph's `TEMPLATE` label says the same when you hover it. Remote paths, values that aren't paths, and jobs with `git_source` get no note.
- **Quick fixes for two findings** ([#165](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/165)). A notebook path without its extension, and an `include` pattern with a likely typo, now have a light bulb in the editor: **Change to "src/etl.py"** or **Change to "resources/*.yml"** applies the suggestion (also from the Quick Fix menu, `Cmd+.` on macOS, `Ctrl+.` on Windows and Linux). The fix edits the path as written in the file, so `../src/etl` in a resource file becomes `../src/etl.py`. It is only offered while the file still holds that value at that place: a path built from a variable, or a line edited since the check, gets no fix. Saving re-checks as usual and clears the problem.

### Changed

- **Each finding's code means one fix, and links to its docs** ([#167](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/167)). Click the code in the Problems panel to open its section in [docs/checks.md](docs/checks.md), which now has one section per code: what it means, an example, its severity, how to fix it, and its limits. Codes that covered several checks are split, so each can be told apart (and, later, ignored on its own):
  - `missing_file` becomes `missing_file`, `notebook_missing_extension` and `missing_pipeline_source`.
  - `notebook_type_mismatch` becomes `not_a_notebook` and `file_is_a_notebook`.
  - `widget_parameter_mismatch` becomes `widget_not_set` (warnings) and `unused_parameter` (notes).
  - `task_value_mismatch` becomes `task_value_unknown_task`, `task_value_not_upstream` and `task_value_key_not_set`.
  - `validation_diagnostic` becomes `cli_diagnostic`, which the Databricks CLI's own messages now also show.

  From now on a code that has shipped is never renamed or removed.

- **A task's problems show when you click it, in any graph mode**, not only in Issues mode. Each problem is labelled and coloured by how serious it is (red **Error**, yellow **Warning**, blue **Note**), errors first. **Show all N issues** expands the list in place, where it used to say "+N more issues". The advice on how to fix a problem is easier to read, in the task panel and in the Issues list. The task's issue chip counts the same problems as the Issue Summary, coloured by the most serious one, where it could say "No issues" above a list of five, and each problem shows its line (`Ln 141`) instead of a cut-off file name, with its full text instead of two lines. Picking a task, from the graph, search or the Issues list, closes the Issues list, which used to stay open on top of the task's details. Notes in the Issues list use the info icon.
- **The status bar says what was checked, and covers the whole folder when it has several bundles** ([#181](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/181)). With one bundle, a clean check reads `Bundle: no problems · 12 tasks`, and the tooltip says what it covered (`Checked 3 jobs, 12 tasks and 8 files.`). With several, the item counts every bundle, the same as the Problems panel (`3 bundles: 5 problems`), instead of only the bundle of the open file, and its tooltip lists the first 3 bundles, those with problems first, and a **Show N more** link that opens the bundle picker. Tooltips are shorter: one line, or the list, instead of several sentences. Bundles not checked yet are never counted as clean (`3 of 12 bundles checked: no problems`). While a check runs longer than half a second the icon turns, except when `workbench.reduceMotion` is `on`. A bundle whose `databricks.yml` is deleted, or whose workspace folder is removed, is dropped instead of showing as not checked.

### Fixed

- **Closing the graph while it is still opening no longer breaks it for the rest of the session.** The graph's close was missed if it happened while the graph loaded, so every later Inspect and refresh failed ("Webview is disposed"), and the graph's data could be lost. Seen on Windows, where loading is slower.
- **Large bundles are read.** The Databricks CLI's output was capped at Node's default of 1 MiB, so a bundle of about 1,000 tasks with long descriptions failed with "Failed to validate Databricks bundle" and no reason. The limit is now 64 MB, and output beyond it says so.
- **A check that runs out of time says it timed out**, instead of "Failed to validate Databricks bundle".
- **A folder whose name starts with `..`, such as `..data`, is treated as part of the bundle**, so `sync.exclude` and `.gitignore` apply to it and a new YAML file in it is noticed. It was mistaken for a folder above the bundle.
- **On Windows, an `include` entry written with backslashes (`resources\*.yml`) is matched as the Databricks CLI matches it**, as a folder separator, for the include warnings.
- **The graph no longer scrolls out of view in a short editor.** With the Problems panel open below a small editor, the Issues list could reach past the bottom of the graph, so scrolling it moved the whole page: the header slid off the top and a light strip showed at the bottom. The Issues list and search results now fit the space and scroll on their own, and the page itself never scrolls.
- **With a target picked, a path the Databricks CLI rejects is still checked in the right folder** ([#187](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/187)). When one path in a resource file failed the CLI's own check, the CLI left every path relative to the bundle root, and the inspector looked for them next to the resource file: a notebook path without its extension lost its "Did you mean ...?" hint and quick fix, and a missing file was looked for in the wrong folder. Paths are now read back as written, only where both name the same file. A path overridden under `targets` in `databricks.yml` is also read from there.
- **Saving a file keeps the job you selected in the graph**, including after opening Bundle Issues. Refreshing used to reset that view and switch back to the job it first opened on.
- **Inspecting a nested bundle uses that bundle.** When a nested bundle used `databricks.yaml` and its parent used `databricks.yml`, the CLI could load the parent instead. Every check now explicitly selects the bundle being inspected, including when an inherited environment variable points elsewhere.
- **Inspect from a resource file chooses its first job when the cursor is outside the job definitions**, including a later variables or pipelines section. It used to choose the last job. Invalid YAML is no longer used to choose a job.
- **The include quick fix only edits the entry itself.** It checked a whole line for the entry, so on a line edited to `- resource/*.yml resource/*.yml`, which YAML reads as one value, it could change only the second half. Both quick fixes now check the exact place the value starts, and offer nothing for a value written with an escape (`"a\"b"`, `'it''s'`) or followed by more text.
- **A Databricks CLI warning shows once in the Problems panel**, not twice: after a successful check it was listed by the CLI, without a code, and again by the inspector.
- **The graph reports the same problems as the Problems panel.** The graph's checks were given only part of the bundle config, without `sync` and `include`. In a bundle with `sync.paths`, which the inspector does not model, the graph could say files "may not be deployed" because of a `.gitignore` rule; in one bundle it showed 37 such warnings the Problems panel didn't. And it left out "defines resources, but no include entry loads it" warnings.
- **The Databricks CLI is found in more places when it's installed but VS Code can't see it** ([#180](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/180)). When `databricks` on VS Code's `PATH` doesn't work, the inspector now also tries every other `databricks` on the `PATH` (for when the first is another program), on Windows the `Path` Windows has stored (so a WinGet install works without restarting VS Code), and the CLI the Databricks extension ships. Each is checked with `--version` first. Nothing changes where the CLI was already found.
- **The status bar says why the Databricks CLI can't be used**, instead of "Databricks CLI not found" for every case: "Legacy Databricks CLI (0.18.0)" when the `databricks` found is the legacy `databricks-cli` pip package, ""databricks" is another program" for anything else, and "Check the cliPath setting" when the setting is wrong. The popup names the legacy package too, and no longer says to put the CLI first on your `PATH`, which is no longer needed.

## [0.3.1] - 2026-10-19

### Fixed

- **Choosing a login profile no longer means editing settings or reading CLI advice you can't follow.** When several profiles in `~/.databrickscfg` point at a picked target's workspace, the Databricks CLI refuses to choose, and its message told you to set `DATABRICKS_CONFIG_PROFILE` or pass `--profile`, which can't be done from VS Code. The graph now says which profiles match and offers a **Choose profile** button that lists just those; the choice is saved and the target is checked again. The **Choose Databricks Login Profile** command changes it later.
- **No pop-up for a picked target's errors.** They are listed in the graph, which is on screen. The structural preview's warning is reworded.

### Changed

- **`databricksBundleInspector.profile` is now a machine setting**: it is kept in your user settings, not synced to other machines, and not read from a workspace's settings, since profile names belong to one machine. A profile saved in a workspace's settings with 0.3.0 is no longer used; choose it again when the graph asks.

## [0.3.0] - 2026-10-19

### Added

- **Pick a target in the graph again.** The dropdown at the top of the graph lists "structural preview" and each of the bundle's targets. A real target shows the bundle as the CLI resolves it for that target, with its variables and configuration. It uses your Databricks login and may contact the workspace. With a login, the CLI gives workspace paths instead of local ones (for example a notebook path becomes `/Workspace/.../files/src/load`); the inspector matches them to the paths as written in your YAML (variables included) and reads those local files, so checks that read your files (widgets, secrets, task values, notebook rules) run for the target too, including when `sync.paths` reaches outside the bundle. A path it can't match to exactly one local file stays as the CLI gave it, and its checks are skipped for that target. When the CLI reports a problem with the target, such as a login error, it is listed with the graph's issues. The Problems panel and the status bar keep showing the structural preview, which needs no login, so saving a file never switches them to another target. The picker was removed in 0.1.1 because a real target made the CLI create a `.databricks` folder in the bundle; the extension now has the CLI keep its working files in your system's temp folder, so nothing is written into the bundle folder.
- **A `databricksBundleInspector.profile` setting** for the `~/.databrickscfg` profile to use when you pick a target. Needed when several profiles point at the same workspace: the CLI then refuses to choose one. The structural preview doesn't use it.

### Fixed

- **With a real target selected, a finding on a task now points at that task's line.** The Databricks CLI sorts each job's tasks by `task_key` when it resolves a real target, and the inspector found a task's line by its position in that sorted list. In a job whose tasks are not written in alphabetical order, a missing file or a secret in a task's cluster could be shown on another task's line. The structural preview, the default, was not affected. A task that is not written in the job's file, such as one a target adds, is now shown without a line instead of on another task's line.
- **Usage events logged right after VS Code starts are no longer held back until the next send.** A send that had just finished could swallow a request to send newer events.

### Changed

- **Usage telemetry now waits for you.** Nothing is sent until you have closed or answered the telemetry notice, and nothing from that VS Code window: events wait on your machine and are sent from the next time VS Code is opened, so you have time to turn it off. Before, events could be sent about a minute after the notice was requested, or when VS Code closed, even if you had not seen it. A notice that never reached the screen (VS Code closed first, or Do Not Disturb) is now shown again instead of counting as seen. If you already got the notice in an earlier version, nothing changes for you.

## [0.2.2] - 2026-10-18

### Added

- **A Locate CLI… button when the Databricks CLI isn't found.** If the CLI is installed but VS Code can't see it, for example right after an install on Windows before VS Code is restarted, pick the file yourself. The extension checks that it is the Databricks CLI, saves it as your `databricksBundleInspector.cliPath` setting, and inspects again. A file that isn't the CLI is refused with what it printed. The not-found message is also shorter.

### Fixed

- **Notebooks with Windows line endings (CRLF) now have their `%run` lines read.** Git on Windows saves files this way by default. Before, every `%run` in such a notebook was ignored, so widgets set by the notebook it runs were reported as missing, and widgets that notebook reads were not checked.

## [0.2.1] - 2026-10-13

### Security

- **The extension no longer lets the Databricks CLI run scripts or Python that a bundle defines.** The README and security policy said bundle code is never run. That was not true for one case: the CLI runs a bundle's `experimental.scripts.preinit` command during `bundle validate`, which is what the extension calls, and since 0.2.0 it calls it as soon as a trusted folder with a bundle is opened. The CLI can also run Python from a bundle's `python` section when a real target is inspected. The extension now starts the CLI in its restricted mode, where it refuses both. A bundle that uses them still loads, with a warning that its scripts or Python were not run. Resources that only Python defines are not shown. VS Code's folder trust was, and still is, required before the extension runs at all.

### Added

- **A status bar item in bundle projects.** It shows `Bundle: no problems`, the number of problems the checks found (errors and warnings), or the number of notes when there is nothing worse. It updates on every check. In a folder with several bundles it counts the bundle of the file in front, and a click first asks which bundle to open, with each one's result beside its name. Click it from any file to open the graph with the issues. Before, the way into the graph was only on screen while `databricks.yml` was the open file.
- **You are told when the Databricks CLI is missing, without clicking Inspect.** The status bar item then says `Databricks CLI not found`, highlighted, and clicking it shows the install steps. Before, the checks silently did nothing and an empty Problems panel looked like a clean bundle. No pop-up is shown unless you click.

### Fixed

- **A fixed warning on a notebook, Python or SQL file no longer waits for `databricks.yml` to be saved.** Saving such a file in the editor now re-checks the bundle directly. Before, only bundle YAML did, and other files relied on the file watcher, which on macOS and Windows can report a file under another letter case than the folder was opened with (`C:\Projects` for `c:\projects`). Those reports were ignored, so the warning stayed. The extension now also treats both spellings as the same file wherever the file system does.

### Changed

- **Usage telemetry tells a click on the status bar item apart** from the title-bar button (`trigger: status_bar` on the existing inspect event). See `telemetry.json`.
- **The start event in usage telemetry also records how many problems were found**, as a range (for example "2-5"). Never which problems, and no names or paths. It shows whether the checks that now run by themselves find anything. See `telemetry.json`.

## [0.2.0] - 2026-10-12

### Added

- **Checks without running Inspect.** The extension now starts by itself when the open folder contains a `databricks.yml` or `databricks.yaml`, including in a subfolder. It checks the bundles it finds and lists the results in the Problems panel, then checks again on every save. Before, nothing happened until you ran **Inspect Databricks Bundle**, in every new window. These checks are quiet: no panel opens and no message is shown, even when the Databricks CLI is missing. They use the same made-up target as the first Inspect, which needs no login. A folder with many bundles gets its first 10 checked on open, and the rest on save.
- **Warnings for two silent `include` mistakes.** The Databricks CLI loads only the files that `include` selects and stays quiet about the rest. The inspector now warns when a pattern matches nothing and looks like a typo (for example `resource/*.yml` for `resources/*.yml`, or `*.yml` where the files end in `.yaml`), with a "Did you mean" suggestion. It also warns when a YAML file that defines resources isn't covered by any entry (for example one in a sub-folder, since `*` stays within one folder). A file that `databricks.yml` mentions, even in a commented-out include, is left alone. The inspector follows the CLI's real matching rules, which differ from what its documentation says: `**` matches one folder level, and `{a,b}` is not supported.
- **Available on Open VSX** for Cursor, Windsurf and other editors that install extensions from Open VSX. Every release now publishes the same package to both the Visual Studio Marketplace and Open VSX, and the README links to both.

### Changed

- **Usage telemetry records that the extension started**, once per VS Code window: how many bundles the open folders hold as a range, whether one sits at the top of the folder, and whether the Databricks CLI could be run. Never paths or names. See `telemetry.json`. Because the extension now starts by itself, the one-time telemetry notice can appear when you open a bundle folder, before you have run Inspect. Nothing is collected before it is shown, and the uninstall event stays off until then.
- **The extension now declares that it needs a trusted folder.** It was already disabled in VS Code's Restricted Mode. The manifest now says so, with a reason shown in the Extensions view. The README also notes that the Databricks CLI uses your active profile and may contact your workspace.
- **`databricksBundleInspector.cliPath` can only be set in your own settings.** A project's `.vscode/settings.json` can no longer point the extension at a program inside the project. If you shared this path through a project settings file or a dev container, move it to your user settings (or the dev container's machine settings).

## [0.1.8] - 2026-09-28

### Changed

- **New extension icon.** A brick box under a magnifying glass, redrawn to stay readable at the small sizes the Extensions view and Marketplace search use.

## [0.1.7] - 2026-09-28

### Changed

- **The "Databricks CLI was not found" popup says what is actually wrong.** It now tells apart a CLI that isn't installed, a `databricksBundleInspector.cliPath` setting that points at a wrong path, and a `databricks` command on the PATH that isn't the Databricks CLI (usually the legacy `databricks-cli` pip package). An **Open Install Guide** button opens the install section for your OS, and **Open Settings** appears when the setting is the problem.
- **A warning when the Databricks CLI is older than v0.299.0**, the oldest version the inspector is tested with. The inspection still runs. The warning shows once per session, and **Open Update Guide** opens the update section for your OS.
- **The "not found" message suggests restarting VS Code** if the CLI was just installed, since VS Code reads `PATH` only at startup.
- **Usage telemetry records why the CLI wasn't found** (`not_installed`, `configured_path_invalid` or `not_databricks_cli`), whether it is older than v0.299.0, and the OS, OS version and CPU type. See `telemetry.json`.

### Fixed

- **VS Code's Windows device ID (`common.sqmid`) is no longer sent with usage telemetry.** VS Code properties are now kept only if they are on a fixed list, so device IDs VS Code adds later are dropped too.

## [0.1.6] - 2026-09-27

### Added

- **Task values are checked.** A task that reads a value with `dbutils.jobs.taskValues.get(...)` or `{{tasks.<task>.values.<key>}}` gets a warning when that task doesn't exist, isn't upstream through `depends_on`, or never sets the key, with "Did you mean" for close names. `bundle validate` passes for these, and Databricks reports them as errors only when the job runs.
- **`%run` is followed.** Widgets a `%run` notebook defines count as defaults, and a `%run` notebook that reads a widget its `%run` line doesn't pass (`$name="value"`) and that has no default gets a warning. A `%run` of a workspace path or a missing file still skips the check.
- **Widgets created in another language's cells are flagged.** A widget created in a Python cell and read in a SQL cell (or the other way round) isn't set when the notebook runs as a job.
- **dbutils is followed wherever it can be traced.** `self.dbutils`, variables assigned from it, `DBUtils(spark)`, `get_dbutils(spark)`, imports under another name, and the Databricks SDK (`WorkspaceClient().dbutils` and `w.secrets.get_secret(...)`). Calls on something that can't be traced to dbutils aren't counted, so a settings object with a `secrets` attribute isn't taken for Databricks secrets. SQL's deprecated `getArgument('name')` is read too.
- **Notebook widgets are checked against the task's parameters.** A notebook task whose notebook reads a widget that neither the task's `base_parameters` nor the job's parameters pass, and that has no default, gets a warning at the line that reads it: "Notebook reads widget "schema", which this task may not pass. Did you mean "schema_name"?". A task parameter the notebook never reads gets an info note. Python and SQL notebooks are both read: `dbutils.widgets.get`, SQL `:name` markers (including inside `IDENTIFIER()`), legacy `${name}`, and defaults from `dbutils.widgets.text` or `CREATE WIDGET ... DEFAULT`. When a notebook reads widgets by names only known at runtime, the inspector says it couldn't check its parameters instead of guessing. Notebooks that use `%run` are not checked.
- **SQL files are scanned for widgets.** Widget reads in SQL notebooks and files now show in the graph, like Python ones.
- **Files that won't be deployed are flagged.** A task or pipeline that points at a file skipped by `.gitignore` (at any level) or `sync.exclude` gets a warning naming the rule, for example ""../src/helper.py" may not be deployed: it matches .gitignore." `bundle validate` passes for these, so they used to fail only when the job ran. Files added back by `sync.include`, and jobs with a `git_source`, are not flagged.
- **Secrets in cluster config are detected.** `{{secrets/<scope>/<key>}}` in `spark_conf` and `spark_env_vars` of job clusters, task clusters, `clusters` resources and pipeline clusters is linked to the scope and to every task using that cluster, at the YAML line.
- **Secrets used inside `for_each` tasks and in pipeline sources are detected.**
- **A hint when code names a secret scope by its bundle resource key.** For example `app_scope` where the bundle's scope is named `app-secrets`: "Secret scope "app_scope" may not exist. Did you mean "app-secrets"?"

### Changed

- **The Marketplace listing and README lead with what the inspector catches** before deploy, and name Lakeflow Spark Declarative Pipelines (formerly Delta Live Tables, DLT) so pipeline users can find it.

### Fixed

- **Bundles with a job that has no body, or a numeric `run_job_task.job_id`, no longer break the inspector.** Found by running it over the 605 bundles in the Databricks CLI's acceptance tests.
- **Code is read with real Python and SQL tokenizers instead of patterns.** Widget and secret detection now tells code from strings and comments exactly, and reads each notebook cell in its own language. Checked against every Python, SQL and notebook file in Databricks' bundle-examples and delta-live-tables-notebooks repositories (246 files) and this repository's sample bundles (247 more). Fixes:
  - Calls inside multi-line `"""` strings and Jupyter markdown cells are no longer read as code.
  - `%sql` cells in Python notebooks and `%python` cells in SQL notebooks are now read.
  - A JSON path with a space before the colon, such as `details :cluster_utilization.num_executors`, is no longer taken for a widget.
  - Legacy `${name}` references inside backtick identifiers are found.
  - f-strings that reuse their quote inside an expression (Python 3.12) are read correctly.
- **Notebook and file paths follow the Databricks CLI's rules.** The inspector now reports the same path errors `bundle deploy` would, checked against CLI v1.17.0:
  - A local notebook path without its extension is not found, even when `name.py` exists: "Notebook "../src/ingest" may not be found. Did you mean "../src/ingest.py"?". Pipeline notebooks without an extension were wrongly accepted.
  - A notebook task or pipeline notebook pointing at a file whose first line isn't the Databricks notebook header (for example `-- Databricks notebook source`) "may not be a notebook".
  - A Python file, SQL file or pipeline file that has the notebook header "may be a notebook, not a file".
  - Paths in a job with a `git_source` are not checked, as the CLI doesn't check them.
- **Fixing a problem clears it without saving bundle YAML.** Issues were only re-checked when `databricks.yml` or an included YAML file was saved, so creating a missing notebook, or fixing code, left the error in place. The inspector now re-checks when any file the bundle points at is created, changed or deleted, including from the terminal or a branch switch. New YAML files matching `include` and new files under a pipeline glob are picked up too. Files `bundle deploy` would skip (`.gitignore`, `sync.exclude`) don't trigger a re-check.
- **Issues found in code are cleared once fixed.** An issue on a notebook or file, such as a secret scope named by its resource key, could stay in the Problems panel after the fix.
- **Secret scopes are matched by their real name.** Code using a bundle scope's `name` was shown as an external scope, and code using the resource key, which fails at runtime, was linked to the bundle scope. Bundle scopes are now also shown by their name.
- **Issues found in code now reach the Problems panel.** The Problems panel was built without reading file contents, so issues found in notebooks and files only showed in the inspector.
- **Long issue titles wrap to two lines** in the issues panel and a task's issue summary, instead of being cut off. Hover for the full text.

## [0.1.5] - 2026-09-27

### Added

- **Pipeline sources are checked.** A pipeline whose `libraries` point at a notebook or file that doesn't exist, or at a `folder/**` glob with no files, is now reported as an error in the Problems panel at the exact line. The Databricks CLI doesn't catch these during validation, so they used to surface only on `bundle deploy`. Workspace paths, variables and complex glob patterns are not checked.

### Fixed

- **Warnings about a job, task, pipeline or other resource now reach the Problems panel.** The Databricks CLI prints an extra `at <yaml.path>` line for these, and the inspector dropped their file and line, so they never showed up and couldn't be clicked. This affected every CLI version since 0.1.0. Issues now also carry the YAML path they apply to. This fixes this [issue](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/75).
- **All 20 job task types are recognised, and valid tasks are no longer flagged.** Tasks such as Power BI and Spark Submit showed an "Unknown task type" warning on perfectly valid bundles. Newly recognised: `alert_task` (which replaces `sql_alert_task`, no longer in the bundle schema), `dbt_cloud_task`, `ai_runtime_task`, `gen_ai_compute_task` and `python_operator_task`. This fixes this [issue](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/76).
- **Power BI, Clean room and dbt platform tasks now show their details** (connection, notebook name and job ID). They read fields that don't exist in the bundle schema, so the detail line was always empty.
- **dbt platform tasks are no longer shown as using a SQL warehouse.** They run on dbt's platform and have no warehouse setting.
- **Warnings about a pipeline no longer appear under unrelated jobs.** A job's issue list now shows only issues on its own tasks, on the job itself, or on the whole bundle.
- **Files used by the task inside a `for_each` task are checked.** A missing file, library or undefined variable there was never reported. It now appears against the `for_each` task, at the right line.
- **A bundle with no jobs now lists its issues in the inspector.** The issues panel was always empty when there was no job to select, even when the Problems panel had errors, for example in a bundle with only pipelines.
- **Notebooks at workspace paths such as `/Users/...` or `/Shared/...` are no longer reported as missing local files.**
- **Each task on the graph shows its own badge.** dbt, JAR, Spark Submit, Python wheel and the new AI task types all showed "PY", and alert tasks showed "T". They now show DBT, JAR, SUB, WHL, AIR, GAI, PYOP, ALRT and so on. A task type the inspector doesn't recognise shows "?".

### Changed

- **A task type the inspector doesn't recognise is now an information note, not a warning.** It reads "Task type not recognised by the inspector", and the task on the graph shows its type key. A mistyped task key is still flagged, because the Databricks CLI reports it as an unknown field.
- **Minimum Databricks CLI raised to `v0.299.0`** (previously `v0.270.1`). `v0.299.x` is the only 0.x line Databricks still patches, and older versions are no longer tested.

### Tests

- A weekly check, also run on every pull request, tests the inspector against the latest Databricks CLI and `v0.299.2`. It covers warnings with their file and line, all 20 task types, and a check that fails when the CLI's bundle schema gains a task or resource type the inspector doesn't know about.

## [0.1.4] - 2026-09-22

### Added

- **Anonymous usage telemetry.** This release starts collecting anonymous usage data: which features are used, how bundle inspections turn out, and an event when the extension is uninstalled. It never collects file paths, file contents, or bundle, job, task or target names. A one-time notice explains this, with a button to turn it off.
  - **Opt out** with the new `databricksBundleInspector.telemetry.enabled` setting, or turn off `telemetry.telemetryLevel` for all of VS Code. Either one stops all collection.
  - Every event is listed in [telemetry.json](./telemetry.json). See the [Telemetry](./README.md#telemetry) section of the README for details.

## [0.1.3] - 2026-05-27

### Fixed

- **Parameter precedence corrected**: job parameters now correctly take precedence over task `base_parameters` when computing effective parameter values in the graph, matching Databricks runtime behaviour. Previously, task `base_parameters` were incorrectly overriding job parameters with the same key. This fixes this [issue](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/59)

## [0.1.2] - skipped

Tag `v0.1.2` was tombstoned by GitHub after being created under a tag immutability rule and subsequently deleted. GitHub permanently prevents recreation of tag names that were deleted under such a rule, making `v0.1.2` unpublishable. Skipped in favour of `v0.1.3`.

## [0.1.1] - 2026-05-04

### Changed

- Simplified README to focus on structural DAG visualization and removed development/testing documentation.
- Disabled target selection dropdown in the panel. The extension now displays "structural preview" only, removing the ability to switch between targets. This aligns with the focus on structural inspection.

## [0.1.0] - 2026-05-04

Initial public release. The extension is a read-only inspector for Declarative Automation Bundles (previously known as Databricks Asset Bundles). It runs `databricks bundle validate --output json`, renders the resolved bundle as an interactive graph, and surfaces bundle issues in VS Code's native Problems panel. Everything operates on the CLI-resolved bundle. The extension does not modify YAML and does not call Databricks workspace APIs.

### Added

#### Bundle inspection
- New command **Inspect Databricks Bundle** (`databricksBundleInspector.inspectBundle`). Opens an interactive graph of the resolved bundle in a VS Code webview.
- React Flow graph view with pan, zoom, search, header chip panel, node legend, and node selection. Built on `@xyflow/react`.
- First-class extraction for jobs, tasks, pipelines, and `depends_on` edges.
- Support for 17+ Databricks task types, including `notebook_task`, `sql_task`, `spark_python_task`, `python_wheel_task`, `dbt_task`, `dbt_platform_task`, `for_each_task`, `condition_task`, `run_job_task`, `dashboard_task`, `pipeline_task`, `power_bi_task`, `clean_rooms_notebook_task`, `sql_alert_task`, `spark_jar_task`, `spark_submit_task`, plus `job_cluster_key` and `existing_cluster_id` compute attachments.
- Click-to-open from graph nodes opens the source file in the editor at the correct line and column. Notebooks (`.ipynb`) open at the top via the Jupyter editor.

#### Issue detection and Problems panel integration
- New command **Open Bundle Issues** (`databricksBundleInspector.openBundleIssues`). Reveals the inspector with the issues panel focused.
- Six typed inspector issue kinds:
  - `missing_file` (error): local file references that do not exist on disk.
  - `missing_library` (error): local library artifacts that do not exist.
  - `unresolved_variable` (error): variable references not defined in the bundle.
  - `unknown_or_deprecated_field` (warning): fields the CLI flagged as unknown or deprecated.
  - `unknown_task_type` (warning): tasks the inspector does not recognize.
  - `validation_diagnostic` (severity from CLI): pass-through of CLI bundle diagnostics with file/line/column.
- Each issue carries `severity`, `kind`, `title`, `detail`, `taskId`, `taskName`, `yamlPath`, `fixHint`, and resolved `file`/`line`/`column`.
- Inspector issues are emitted to VS Code's Problems panel under the source label `Databricks Bundle Inspector (<bundle name>)` so they appear alongside other diagnostics.
- CLI bundle diagnostics are emitted under a separate source `Databricks Bundle (<bundle name>)`.
- **On-save diagnostics**: after a bundle has been inspected, saving the bundle file, an included YAML file, or a tracked referenced source file re-runs validation for the owning bundle and clears stale diagnostics for files that are now clean.

#### Databricks CLI integration
- New configuration setting `databricksBundleInspector.cliPath`. When empty, the extension uses `databricks` from the system `PATH`.
- **Probe target fallback**: validation runs against a synthetic target (`__bundle_inspector_probe__`) by default so the CLI produces resolved bundle JSON without requiring workspace authentication.
- **Target fallback path**: when a user-requested target fails, the extension automatically falls back to the probe target and surfaces a warning so structural inspection still works.
- **Auth-error recovery**: if the CLI emits valid JSON on stdout but fails with `cannot configure default credentials`, the bundle is still parsed and surfaced with an `AUTH_NOT_CONFIGURED` issue.
- Structured error taxonomy:
  - `CLI_NOT_FOUND`: Databricks CLI could not be located.
  - `CLI_NOT_EXECUTABLE`: CLI was found but failed to execute.
  - `VALIDATION_TIMEOUT`: validation exceeded the 30 second timeout.
  - `INVALID_BUNDLE_SHAPE`: CLI returned JSON that did not match the expected schema.
  - `VALIDATION_FAILED`: validation completed with errors.
  - `AUTH_NOT_CONFIGURED`: parsed bundle returned despite missing credentials.
  - `BUNDLE_DIAGNOSTICS`: CLI reported diagnostics on stderr.
  - `CLI_WARNING`: validation completed with warnings.

#### Source-file enrichment
- Local task source files are read after graph extraction and used to enrich nodes with detected:
  - **Secret scope references** via `dbutils.secrets.get(...)` in Python and SQL, case-insensitive.
  - **Widgets**.
  - **F-string expressions** inside Python source.
- Enrichment is read-only and best-effort; unreadable files do not fail the inspector.

#### Editor surface
- Title bar and editor context menu entries for **Inspect Databricks Bundle**, gated to `databricks.yml` and `databricks.yaml`.
- **Inspect Databricks Bundle** and **Open Bundle Issues** are available from the Command Palette.

### Engineering

- Zod-based runtime schema validation of CLI output (`ParsedBundleConfigSchema`). The cast from `JSON.parse` to `ParsedBundleConfig` is verified at runtime, not just at compile time.
- Content Security Policy on the webview with a cryptographically generated nonce per render. `connect-src` is set to `'none'`. Webview resources are loaded through `webview.asWebviewUri`.
- 30 second timeout on every CLI invocation.
- Diagnostic collection lifecycle is managed: stale entries are cleared per file when validation no longer reports them.

### Tooling

- Node 22 dev container (`.devcontainer/`) with the Databricks CLI installed inside the container and `databricksBundleInspector.cliPath` preset.
- Husky pre-commit and pre-push hooks. Lint-staged runs ESLint with autofix on staged TypeScript files.
- GitHub Actions CI workflow.
- Trufflehog secret scanning in CI.
- `vsce`-ready manifest with display name, categories, keywords, repository, homepage, bugs, and Q&A links.

### Tests

- Unit tests for `bundleGraph`, `issues`, `jobDocumentation`, `documentationPolicy`, `documentationSignals`, `parseBundleDiagnostics`, `semanticGraph`, `sourceLocations`, `taskFileDetections`, `taskNodeData`, `validateBundle`, `bundleContext`, `parsing`, `processRunner`, and `jobSelection`.
- Integration tests for `validateBundle` against a real CLI binary (`semanticCli.integration.test.ts`, `verifyCliPath.integration.test.ts`).
- Golden semantic graph baselines for three fixture bundles (`broken-job`, `multi-job-dag`, `secret-scope-example`). Each fixture commits a `validated-bundle.json` and a `validated-bundle.meta.json` carrying CLI version, generation timestamp, target, and SHA-256 provenance of the JSON payload.
- Live CLI compatibility matrix runner (`scripts/run-semantic-cli-matrix.mjs`) and a script to install pinned Databricks CLI releases from GitHub for local matrix testing (`scripts/install-databricks-cli-matrix.mjs`).
- Compatibility floor for v0.1.0: Databricks CLI `v0.270.1+`, scoped to the fixtures covered by the committed matrix.

### Known limitations

- Paths under `/Workspace/...`, `/Repos/...`, `/Volumes/...`, `dbfs:/...`, and cloud URIs (`s3://`, `abfss://`, `gs://`) cannot be validated locally. They are accepted as resolved references; only local paths are checked for existence.
- The extension does not call Databricks workspace APIs and does not detect drift between the local bundle and a deployed workspace. This is intentional.
- The extension does not edit `databricks.yml` or any included YAML. For graphical authoring, see complementary tools that operate on the YAML directly.
- The webview operates on one bundle at a time. Multi-bundle workspaces can be inspected by opening each bundle file and running the inspector.

### Compatibility

- VS Code `^1.85.0`.
- Node 22 (development).
- Databricks CLI `v0.270.1` or newer.

[0.3.1]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/uncoverthestack/databricks-bundle-inspector/releases/tag/v0.1.0

# Changelog

All notable changes to the **Databricks Bundle Inspector** extension are documented in this file.

## [Unreleased]

## [0.1.6] - 2026-09-27

### Added

- **Secrets in cluster config are detected.** `{{secrets/<scope>/<key>}}` in `spark_conf` and `spark_env_vars` of job clusters, task clusters, `clusters` resources and pipeline clusters is linked to the scope and to every task using that cluster, at the YAML line.
- **Secrets used inside `for_each` tasks and in pipeline sources are detected.**
- **A hint when code names a secret scope by its bundle resource key.** For example `app_scope` where the bundle's scope is named `app-secrets`: "Secret scope "app_scope" may not exist. Did you mean "app-secrets"?"

### Changed

- **The Marketplace listing and README lead with what the inspector catches** before deploy, and name Lakeflow Spark Declarative Pipelines (formerly Delta Live Tables, DLT) so pipeline users can find it.

### Fixed

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

[0.1.6]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/uncoverthestack/databricks-bundle-inspector/releases/tag/v0.1.0

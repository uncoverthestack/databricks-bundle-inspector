# Changelog

All notable changes to the **Databricks Bundle Inspector** extension are documented in this file.

## [0.1.2] - 2026-05-27

### Fixed

- **Parameter precedence corrected**: job parameters now correctly take precedence over task `base_parameters` when computing effective parameter values in the graph, matching Databricks runtime behaviour. Previously, task `base_parameters` were incorrectly overriding job parameters with the same key. This fixes this [issue](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/59)

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

[Unreleased]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/uncoverthestack/databricks-bundle-inspector/releases/tag/v0.1.0

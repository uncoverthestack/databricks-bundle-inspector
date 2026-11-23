# Databricks Bundle Inspector (command line)

Find Databricks bundle problems before you deploy, including ones `databricks bundle validate` misses, from a terminal or a CI pipeline.

It runs the same checks as the [Databricks Bundle Inspector extension](https://marketplace.visualstudio.com/items?itemName=UncoverTheStack.databricks-bundle-inspector) for VS Code, on every Declarative Automation Bundle (formerly Databricks Asset Bundle) under a folder, and exits with `1` when it finds errors, so a pull request can fail before anything is deployed.

## Requirements

- **The [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/install), `v0.299.0` or newer.** The inspector runs `databricks bundle validate` to read each bundle exactly as a deploy would. No sign-in is needed.
- Node.js 22 or newer.

## Run it

```sh
npx @uncoverthestack/databricks-bundle-inspector check
```

That checks every `databricks.yml` or `databricks.yaml` under the current folder. Give folders or bundle files to check only those:

```sh
npx @uncoverthestack/databricks-bundle-inspector check bundles/etl bundles/ml/databricks.yml
```

Example output:

```text
bundles/etl (etl)
  error   bundles/etl/resources/nightly.job.yml:15:28  File not found: ./src/load.py  [missing_file]
  warning bundles/etl/src/report.py:9  Notebook reads widget "run_date", which this task may not pass.  [widget_not_set]

1 error, 1 warning and 0 notes in 1 bundle
```

## In GitHub Actions

```yaml
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: databricks/setup-cli@12452ad4003a2dd61d5a7cee30bc068f750a2e00 # v1.27.0
      - run: npx @uncoverthestack/databricks-bundle-inspector@<version> check --format github # an exact version, such as the one you tested
```

`--format github` shows each finding as an annotation on its file and line, in the pull request's changed files where the line is part of the change, and the full report on the run's summary page. Pin an exact version of the inspector, and actions to a commit, as above.

In other CI systems, install the Databricks CLI the way you do for `bundle deploy`, then run the same command with `--format text`, `markdown` or `json`.

## What it catches

Problems that pass `databricks bundle validate` and only fail when you deploy or run the job:

- **Missing files and libraries** that tasks and pipelines point at.
- **Files that won't be deployed**, because `.gitignore` or `sync.exclude` skips them.
- **`include` mistakes**: a pattern with a typo, or a resource file no pattern covers.
- **Notebook and file mix-ups**: a path without its extension, or a notebook where a file is expected.
- **Widgets** a notebook reads that the task doesn't pass.
- **Task values** read from a task that isn't upstream, or that never sets them.
- **Secret scopes** named by their resource key instead of their name.
- **Unresolved variables**.

Each finding names its check, such as `[missing_file]`. [Every check, and what code is read](https://github.com/uncoverthestack/databricks-bundle-inspector/blob/main/docs/checks.md). Checks on code read Python and SQL. Scala and R are not read.

## Targets

By default it checks the structural preview, which needs no sign-in. Paths and values that use variables are then reported as "Not checked".

With `--target`, it checks the target as the Databricks CLI resolves it for a deploy: each target's own paths, variables and overrides. That needs a sign-in to the target's workspace (`databricks auth login`, or the usual `DATABRICKS_HOST` and token or OAuth variables in CI):

```sh
npx @uncoverthestack/databricks-bundle-inspector check --target prod --profile PROD
```

A target that can't be checked is never replaced by the preview: no sign-in, a profile for another workspace, or a workspace that doesn't answer within 60 seconds exits with `3`, and a target the bundle doesn't have exits with `2`. With a sign-in, `bundle validate` creates the target's empty files folder in the workspace if it is missing; nothing is uploaded.

## Options

| Option | Default | |
| --- | --- | --- |
| `--format <text\|json\|markdown\|github>` | `text` | How to print the findings |
| `--fail-on <error\|warning\|note\|never>` | `error` | Exit with `1` when a finding is at least this severe |
| `--output <file>` | | Write the report to a file instead of the terminal |
| `--databricks-cli <path>` | `databricks` on `PATH` | The Databricks CLI to run. A path given here is used or refused, never swapped for another |
| `-t, --target <name>` | the structural preview | Check this target as the Databricks CLI resolves it. Needs a sign-in |
| `-p, --profile <name>` | the CLI's default | The `~/.databrickscfg` profile for `--target` |
| `--no-color` | | Plain text. Also when `NO_COLOR` is set or the output isn't a terminal |

`--format json` has a `schemaVersion`, so scripts can rely on its shape.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Nothing at or above `--fail-on` |
| `1` | Findings at or above `--fail-on`, including errors the Databricks CLI reports |
| `2` | Wrong usage, no bundle found, or a `--target` the bundle doesn't have |
| `3` | Setup problem: no Databricks CLI, one older than `v0.299.0`, or no working sign-in for `--target` |
| `4` | The inspector itself failed |

## Safety

- It runs one program, the Databricks CLI, and only `databricks bundle validate`. Nothing is deployed, planned or run. It sets `DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION`, so the CLI doesn't run scripts or Python a bundle asks it to run.
- It writes nothing into your bundle folders.
- No telemetry, and no network calls of its own. Only with `--target` does the Databricks CLI contact your workspace.
- Names and messages from a bundle are printed as text: never a link, a mention or a GitHub workflow command.
- The package has no dependencies: `dist/cli.cjs` is one readable file. The libraries bundled into it are listed in `THIRD_PARTY_NOTICES.md`.

## Versions

The command-line tool has the extension's version number: the same version of both runs the same checks.

It is published under two names with the same contents: `@uncoverthestack/databricks-bundle-inspector` and `databricks-bundle-inspector`.

[Source, issues and the full documentation](https://github.com/uncoverthestack/databricks-bundle-inspector) · Apache-2.0

# Setup and usage in detail

[Back to the README](../README.md)

## Requirements

The inspector runs `databricks bundle validate`, so it needs the [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/install) installed and on your `PATH`, or set with the `databricksBundleInspector.cliPath` VS Code setting. The legacy `databricks-cli` pip package is a different tool and doesn't work.

If the CLI can't be found, the inspector says why (not installed, a wrong `cliPath`, or the legacy package on your `PATH`) and links to the install steps for your OS.

Tested with Databricks CLI `v0.299.0` and newer. With an older CLI the inspector still runs, but shows a warning, because results may be incomplete. A weekly check runs the inspector against the latest CLI release, so changes in its output are caught soon after they ship.

After installing the CLI, restart VS Code if the install added a new folder to your `PATH` (for example WinGet on Windows, or a first-time Homebrew install). Setting `databricksBundleInspector.cliPath` to the CLI's full path works without a restart.

## Usage

Open a folder containing a `databricks.yml` or `databricks.yaml` file. That is all it takes to get the checks: the extension starts by itself, checks the bundles in the folder, and lists what it finds in the **Problems** panel. It checks again each time you save. It opens no panel and shows no messages while doing so.

A folder with many bundles gets its first 10 checked on open (the ones closest to the top of the folder first). The others are checked when you save one of their files. Bundles inside `node_modules`, `.git`, `.databricks`, `.venv` and `venv` are skipped.

To see the graph:

1. Open the bundle file in the editor.
2. Click **Inspect Databricks Bundle** (editor title bar button) or right-click and select the command.

The graph opens in a new editor panel. It refreshes automatically when you save the bundle file or related configurations.

## Commands

| Command ID | Title | When available |
| --- | --- | --- |
| `databricksBundleInspector.inspectBundle` | Inspect Databricks Bundle | Active file is named `databricks.yml` or `databricks.yaml` |
| `databricksBundleInspector.openBundleIssues` | Open Bundle Issues | Command Palette; focuses issues for the active inspector bundle |

## How it works

The extension runs `databricks bundle validate --output json` to resolve your bundle for the selected target. It then checks the local paths, libraries and pipeline sources the resolved config points at, and scans task notebooks and files for secrets and widgets. Nothing is deployed and your code is never run. The Databricks CLI uses your active profile and may contact your workspace to resolve the bundle, so `validate` can make network calls. Because the extension runs the CLI on the files you open, it is disabled in VS Code's Restricted Mode until you trust the folder. The checks that run by themselves, on open and on save, use a made-up target, which needs no login. The results become Problems panel entries and an interactive graph of jobs, tasks and pipelines, rendered with React Flow.

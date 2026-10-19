# Setup and usage in detail

[Back to the README](../README.md)

## Requirements

The inspector runs `databricks bundle validate`, so it needs the [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/install) installed and on your `PATH`, or set with the `databricksBundleInspector.cliPath` VS Code setting. The legacy `databricks-cli` pip package is a different tool and doesn't work.

If the CLI can't be found, the inspector says why (not installed, a wrong `cliPath`, or the legacy package on your `PATH`) and links to the install steps for your OS. **Locate CLI…** lets you pick the CLI file instead: it is checked, then saved as `databricksBundleInspector.cliPath`.

Tested with Databricks CLI `v0.299.0` and newer. With an older CLI the inspector still runs, but shows a warning, because results may be incomplete. A weekly check runs the inspector against the latest CLI release, so changes in its output are caught soon after they ship.

After installing the CLI, restart VS Code if the install added a new folder to your `PATH` (for example WinGet on Windows, or a first-time Homebrew install). Setting `databricksBundleInspector.cliPath` to the CLI's full path works without a restart.

## Usage

Open a folder containing a `databricks.yml` or `databricks.yaml` file. That is all it takes to get the checks: the extension starts by itself, checks the bundles in the folder, and lists what it finds in the **Problems** panel. It checks again each time you save. It opens no panel and shows no messages while doing so.

A folder with many bundles gets its first 10 checked on open (the ones closest to the top of the folder first). The others are checked when you save one of their files. Bundles inside `node_modules`, `.git`, `.databricks`, `.venv` and `venv` are skipped.

To see the graph:

1. Open the bundle file in the editor.
2. Click **Inspect Databricks Bundle** (editor title bar button) or right-click and select the command.

The graph opens in a new editor panel. It refreshes automatically when you save the bundle file or related configurations.

## Targets

The graph starts as a **structural preview**: the CLI resolves the bundle with a made-up target, so it needs no login or network. To see a real target, pick it in the dropdown at the top of the graph. The CLI then resolves the bundle for that target, which uses your Databricks login and may contact the workspace. When the CLI reports a problem with the target, such as a login error, it is listed with the graph's issues.

With a login, the CLI gives workspace paths instead of local ones (a notebook path becomes something like `/Workspace/Users/<you>/.bundle/<bundle>/<target>/files/src/load`). The inspector reads the local files those paths come from, so the checks that read your files (widgets, secrets, task values, notebook rules) run for the target as well. To know which local file each one is, it compares them with the paths as you wrote them in your YAML (with `${var...}` and `${bundle.target}` filled in from the CLI's values). This works whether files are uploaded from the bundle folder or, with `sync.paths` reaching outside it, from a parent. It needs at least one path written as a plain path or with a variable; if every path is written with `${workspace.file_path}`, nothing is mapped. A path that can't be matched to exactly one local file stays as the CLI gave it, and its checks are skipped for that target rather than run on a guess.

If the CLI stops partway through a target, for example on a variable with no value, it prints what it had resolved so far, and the graph shows that.

If several profiles in `~/.databrickscfg` point at the same workspace, the CLI refuses to choose one. Set `databricksBundleInspector.profile` to the profile to use. The structural preview doesn't use it.

The Problems panel and the status bar always show the structural preview, so they never need a login, including when you save. A picked target changes the graph only.

Nothing is written into your bundle folder. For a real target the CLI would normally create a `.databricks` folder there; the extension has it keep its working files in your system's temp folder instead.

## Commands

| Command ID | Title | When available |
| --- | --- | --- |
| `databricksBundleInspector.inspectBundle` | Inspect Databricks Bundle | Active file is named `databricks.yml` or `databricks.yaml` |
| `databricksBundleInspector.openBundleIssues` | Open Bundle Issues | Command Palette; focuses issues for the active inspector bundle |

## How it works

The extension runs `databricks bundle validate --output json` to resolve your bundle for the selected target. It then checks the local paths, libraries and pipeline sources the resolved config points at, and scans task notebooks and files for secrets and widgets. Nothing is deployed and your code is never run. That includes code a bundle can ask the CLI to run while it loads: shell commands under `experimental.scripts`, and Python under the `python` section. The extension tells the CLI not to run them. A bundle that uses them gets a warning saying so, and resources that only Python defines are not shown. The Databricks CLI uses your active profile and may contact your workspace to resolve the bundle, so `validate` can make network calls. Because the extension runs the CLI on the files you open, it is disabled in VS Code's Restricted Mode until you trust the folder. The checks that run by themselves, on open and on save, use a made-up target, which needs no login. The results become Problems panel entries and an interactive graph of jobs, tasks and pipelines, rendered with React Flow.

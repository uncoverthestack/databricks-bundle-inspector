# Setup and usage in detail

[Back to the README](../README.md)

## Requirements

The inspector runs `databricks bundle validate`, so it needs the [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/install) installed and on your `PATH`, or set with the `databricksBundleInspector.cliPath` VS Code setting. The legacy `databricks-cli` pip package is a different tool and doesn't work.

If the CLI can't be found, the inspector says why (not installed, a wrong `cliPath`, or the legacy package on your `PATH`) and links to the install steps for your OS. **Locate CLI…** lets you pick the CLI file instead: it is checked, then saved as `databricksBundleInspector.cliPath`.

Tested with Databricks CLI `v0.299.0` and newer. With an older CLI the inspector still runs, but shows a warning, because results may be incomplete. A weekly check runs the inspector against the latest CLI release, so changes in its output are caught soon after they ship.

When `databricks` on VS Code's `PATH` doesn't work, the inspector also tries, in this order:

1. every other `databricks` on that `PATH`, for when the first one is something else, such as a legacy pip package older than 0.17.8 (from 0.17.8 the legacy package hands over to the Databricks CLI by itself when both are on the `PATH`);
2. on Windows, the `Path` Windows has stored for you and for the system, read with `reg.exe` (read only). An install adds its folder there, but VS Code only reads it when it starts;
3. the CLI the [Databricks extension](https://marketplace.visualstudio.com/items?itemName=databricks.databricks) ships, if you have it.

Each one is checked with `databricks --version` before it is used. So on Windows a WinGet install works without restarting VS Code. On macOS and Linux, restart VS Code if the install added a new folder to your `PATH` (for example a first-time Homebrew install). Setting `databricksBundleInspector.cliPath` to the CLI's full path always works without a restart.

## Usage

Open a folder containing a `databricks.yml` or `databricks.yaml` file. That is all it takes to get the checks: the extension starts by itself, checks the bundles in the folder, and lists what it finds in the **Problems** panel. It checks again each time you save. It opens no panel and shows no messages while doing so.

A folder with many bundles gets its first 10 checked on open (the ones closest to the top of the folder first). The others are checked when you save one of their files. Bundles inside `node_modules`, `.git`, `.databricks`, `.venv` and `venv` are skipped.

To see the graph:

1. Open the bundle file, or a resource file it loads through `include` (for example `resources/etl_job.yml`).
2. Click **Inspect Databricks Bundle** (editor title bar button) or right-click and select the command.

The graph opens in a new editor panel. From a resource file, it opens on the job your cursor is in, or the file's first job. A resource file gets the button once the bundle has been checked, which happens when the folder opens; a file `include` doesn't load gets none. It refreshes automatically when you save a file the bundle uses and keeps the job you selected.

## Understanding and fixing problems

Click a finding's code in the **Problems** panel to open its explanation in [the checks guide](checks.md). Each code has its own example, severity, fix and limits. The graph's task details also list problems as **Error**, **Warning** or **Note**.

For a notebook path missing its extension, or a mistyped include pattern with a suggested replacement, open the affected YAML line and use the light bulb's **Quick Fix** menu. The fix edits that value; saving the file runs the checks again. It is only offered while the value still matches what was checked.

## Targets

The graph starts as a **structural preview**: the CLI resolves the bundle with a made-up target, so it needs no login or network. To see a real target, pick it in the dropdown at the top of the graph. The CLI then resolves the bundle for that target, which uses your Databricks login and may contact the workspace. When the CLI reports a problem with the target, such as a login error, it is listed with the graph's issues.

In the structural preview, a local file path containing a variable such as `${var.nb_dir}/load.py` gets a **Not checked** note in the Problems panel. The inspector cannot read that file yet, so its file checks have not run. The graph's **TEMPLATE** label explains this too. Pick a target to let the CLI resolve the path; a target may need a Databricks login. If the path still contains a variable afterward, the note says it remains unchecked.

With a login, the CLI gives workspace paths instead of local ones (a notebook path becomes something like `/Workspace/Users/<you>/.bundle/<bundle>/<target>/files/src/load`). The inspector reads the local files those paths come from, so the checks that read your files (widgets, secrets, task values, notebook rules) run for the target as well. To know which local file each one is, it compares them with the paths as you wrote them in your YAML (with `${var...}` and `${bundle.target}` filled in from the CLI's values). This works whether files are uploaded from the bundle folder or, with `sync.paths` reaching outside it, from a parent. It needs at least one path written as a plain path or with a variable; if every path is written with `${workspace.file_path}`, nothing is mapped. A path that can't be matched to exactly one local file stays as the CLI gave it, and its checks are skipped for that target rather than run on a guess.

If the CLI stops partway through a target, for example on a variable with no value, it prints what it had resolved so far, and the graph shows that.

If several profiles in `~/.databrickscfg` point at the same workspace, the CLI refuses to choose one. The graph then lists the matching profiles with a **Choose profile** button; your choice is saved in your user settings (`databricksBundleInspector.profile`) and the target is checked again. To change it later, run **Choose Databricks Login Profile** from the Command Palette. The structural preview doesn't use a profile.

The Problems panel and the status bar always show the structural preview, so they never need a login, including when you save. A picked target changes the graph only.

The status bar item sums up the last checks:

- **One bundle in the folder:** the result, then what was checked, for example `Bundle: no problems · 12 tasks`. The tooltip says how many jobs, tasks, pipelines and local files the check covered.
- **Several bundles:** the whole folder, for example `3 bundles: 5 problems`, the same count as the Problems panel. The tooltip lists the first 3 bundles, those with problems first; **Show N more** opens the picker with every bundle and its result. A folder with many bundles only gets its first few checked when it opens; the others are never counted as clean (`3 of 12 bundles checked: no problems`).
- **While a check runs** longer than half a second, its icon turns. It stays still when `workbench.reduceMotion` is `on`.
- **When the Databricks CLI can't be used,** it says why, highlighted.

Nothing is written into your bundle folder. For a real target the CLI would normally create a `.databricks` folder there; the extension has it keep its working files in your system's temp folder instead.

## Commands

| Command ID | Title | When available |
| --- | --- | --- |
| `databricksBundleInspector.inspectBundle` | Inspect Databricks Bundle | Active file is `databricks.yml` or `databricks.yaml`, or a file the bundle's `include` loads |
| `databricksBundleInspector.openBundleIssues` | Open Bundle Issues | Command Palette; focuses issues for the active inspector bundle |
| `databricksBundleInspector.chooseProfile` | Choose Databricks Login Profile | Command Palette; lists the profiles in `~/.databrickscfg` and saves the one used when you pick a target |

## How it works

The extension runs `databricks bundle validate --output json` to resolve your bundle for the selected target. It then checks the local paths, libraries and pipeline sources the resolved config points at, and scans task notebooks and files for secrets and widgets. Nothing is deployed and your code is never run. That includes code a bundle can ask the CLI to run while it loads: shell commands under `experimental.scripts`, and Python under the `python` section. The extension tells the CLI not to run them. A bundle that uses them gets a warning saying so, and resources that only Python defines are not shown. The Databricks CLI uses your active profile and may contact your workspace to resolve the bundle, so `validate` can make network calls. Because the extension runs the CLI on the files you open, it is disabled in VS Code's Restricted Mode until you trust the folder. The checks that run by themselves, on open and on save, use a made-up target, which needs no login. The results become Problems panel entries and an interactive graph of jobs, tasks and pipelines, rendered with React Flow.

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

A folder with many bundles gets its first 10 checked on open (the ones closest to the top of the folder first). The others are checked when you save one of their files. Bundles inside `node_modules`, `.git`, `.databricks`, `.venv`, `venv`, `site-packages`, `.tox` and `__pycache__` are skipped. A bundle made while the folder is open shows up on its own. On Linux, VS Code can miss a bundle file written the instant its folder is made (a `cp -r` of a bundle folder missed about 1 in 50 to 200 times in testing); **Check All Databricks Bundles Again** searches the open folders and finds it.

To see the graph:

1. Open the bundle file, or a resource file it loads through `include` (for example `resources/etl_job.yml`).
2. Click **Open Graph** (the cube and magnifier button in the editor title bar), or right-click and choose **Open Graph**. In the Command Palette it is **Databricks Bundle Inspector: Open Graph**.

The graph opens in a new editor panel. From a resource file, it opens on the job or pipeline your cursor is in, otherwise the file's first job, or its first pipeline when it has no jobs. A resource file gets the button once the bundle has been checked, which happens when the folder opens; a file `include` doesn't load gets none. It refreshes automatically when you save a file the bundle uses and keeps the job you selected.

The dropdown in the graph's header lists the bundle's **Jobs**, then its **Pipelines**. A bundle with only pipelines opens on its first pipeline. A pipeline shows what its YAML says, with nothing read from its table code:

- **Run by a job in this bundle**: each job with a `pipeline_task` that points at it. Click one to see that job's tasks. Jobs outside the bundle that run it aren't known.
- **Default catalog · schema**: the pipeline's `catalog` and `schema` (or the older `target`). Databricks puts tables there unless the code names another catalog or schema.
- **Sources**: each entry in `libraries`, marked **Found**, **Missing**, **No files** (a folder pattern that matches nothing), **Not a notebook**, or **Not checked** (a workspace path, a variable, or a pattern the inspector doesn't read). Click a path to open the file, or its location to open the YAML line.
- **Issues**, **Configuration** (mode is **Triggered** unless `continuous: true`) and the **Secret scopes** found in its `.py`, `.sql` and `.ipynb` sources and cluster settings.

The graph doesn't show the tables inside a pipeline. In a job's graph, a pipeline task's **Pipeline** row opens its pipeline.

**Copy review**, at the right of the graph's header, copies a Markdown review of the job or pipeline the graph shows, for a pull request or a chat. For a job it's a menu:

- **Short summary**: the bundle, target and job, up to 12 problems, each labelled **Error** or **Warning** with errors first, the parameter flow, the schedule and file counts. For Slack, Teams or Jira, which don't draw diagrams.
- **Full report**: for GitHub or GitLab. A table with the bundle, target, job, how it starts, the Databricks CLI's version, the inspector's version and when it was checked; the error and warning counts; a picture of the job as a [Mermaid](https://mermaid.js.org) diagram, from how it starts to its last task, with tasks that have problems in red (error) or amber (warning), pipelines rounded, if/else conditions as diamonds and for-each loops as dashed boxes; the errors, then the warnings, with the task, file and line; tables of the tasks (problems first), job parameters and files; and what the report can't vouch for. A job with more than 50 tasks gets no picture, and its tables stop at 50 rows. The report stays under 60,000 characters, below GitHub's 65,536 for a comment: when it would be longer, it keeps the header, counts, errors and warnings first and says what it left out.

A pipeline has the short summary only.

## Sidebar

The **Databricks Bundle Inspector** icon in the Activity Bar (a cube with a magnifier) opens a sidebar with two sections.

**Bundles** lists every bundle in the open folders, named by its folder, with the same result as the status bar (`2 problems`, `no problems`, `not checked yet`, or why the Databricks CLI can't be used). When two bundles have the same folder name, each also shows where it is, for example `teams/sales/analytics`. The bundle of the file you have open is selected, as the Explorer selects the open file. Hover a bundle for **Open Bundle File** (its `databricks.yml`) and **Check Again**; right-click it for **Open Graph** too. **Check All Databricks Bundles Again**, at the top of the section, checks every bundle, one at a time.

Under each bundle (open already when the folder has only one):

- **Open Graph** shows what the last check covered (`3 jobs · 11 tasks`), or the target picked in the graph. Click it to open the graph; a graph already open on that bundle comes to the front as it is, with its target. A target the CLI couldn't check shows as `<target> couldn't be checked`, and the graph shows the structural preview.
- **Problems** shows how many problems the last check found, and that they come from the structural preview: your bundle with no target applied, checked without signing in (`2 · structural preview`, or `none found · structural preview`). Click it to open the problem where it is, in your YAML or notebook, with its explanation below the line, as F8 does. With several, often in several files, it first lists them all under their file names, each with its task (`fanout_b · File not found: …`) and line: move through the list to see each one in the editor, and pick one to open it. The icons show the most severe problem: red when there is an error. Problems with no line in a file are listed too, and open the graph. A target can still have its own problems: pick it in the graph to check it.
- **Target definitions** lists the targets the bundle's last check found, by name. Click one to open where it is defined, in the bundle file or a file its `include` loads. The one the graph uses says `graph in use`.

The Problems panel and the status bar always use the structural preview. VS Code keeps what you expanded and selected when the rows update.

**Settings** shows the Databricks CLI the checks use, its version and where it is from (`on PATH`, the `cliPath` setting, the Databricks extension, or on Windows the Path Windows has stored), with a warning when it is older than `v0.299.0`. Click it to see every Databricks CLI found, each with its version, where it is from and its file, the one in use ticked. Pick one to use it (it is saved to `databricksBundleInspector.cliPath` and every bundle is checked again), browse for one, or go back to the one on your PATH. Below it is the sign-in profile for targets (`CLI default` unless you chose one); click it to choose a profile from `~/.databrickscfg`. When no CLI can be used, a line above the bundles says so, and the CLI row also offers **Locate the Databricks CLI…** and the install guide.

The `...` menu of the Bundles section opens this guide or a new issue on GitHub. With no bundle in the open folders, the section says so and links here.

## Understanding and fixing problems

Click a finding's code in the **Problems** panel to open its explanation in [the checks guide](checks.md). Each code has its own example, severity, fix and limits. The graph's task details also list problems as **Error**, **Warning** or **Note**.

For a notebook path missing its extension, or a mistyped include pattern with a suggested replacement, open the affected YAML line and use the light bulb's **Quick Fix** menu. The fix edits that value; saving the file runs the checks again. It is only offered while the value still matches what was checked.

## Targets

The graph starts as a **structural preview**: the CLI resolves the bundle with a made-up target, so it needs no login or network. To see a real target, pick it in the dropdown at the top of the graph. The CLI then resolves the bundle for that target, which uses your Databricks login and may contact the workspace.

When the CLI stops on an error after it has applied the target, for example a missing notebook or a variable with no value, the graph shows the target and lists the error with its issues. When it stops before that, for example because you are not logged in, the graph shows the structural preview instead, with a note giving the CLI's reason. Saving then refreshes the preview, and picking the target again retries it.

With a login, `bundle validate` also creates the target's files folder in your workspace if it is missing (by default `/Workspace/Users/<you>/.bundle/<bundle>/<target>/files`). The folder is empty: nothing is uploaded. The structural preview never contacts the workspace.

In the structural preview, a local file path containing a variable such as `${var.nb_dir}/load.py` gets a **Not checked** note in the Problems panel. The inspector cannot read that file yet, so its file checks have not run. The graph's **TEMPLATE** label explains this too. Pick a target to let the CLI resolve the path; a target may need a Databricks login. If the path still contains a variable afterward, the note says it remains unchecked.

With a login, the CLI gives workspace paths instead of local ones (a notebook path becomes something like `/Workspace/Users/<you>/.bundle/<bundle>/<target>/files/src/load`). The inspector reads the local files those paths come from, so the checks that read your files (widgets, secrets, task values, notebook rules) run for the target as well. To know which local file each one is, it compares them with the paths as you wrote them in your YAML (with `${var...}` and `${bundle.target}` filled in from the CLI's values). This works whether files are uploaded from the bundle folder or, with `sync.paths` reaching outside it, from a parent. It needs at least one path written as a plain path or with a variable; if every path is written with `${workspace.file_path}`, nothing is mapped. A path that can't be matched to exactly one local file stays as the CLI gave it, and its checks are skipped for that target rather than run on a guess.

If the CLI stops partway through a target, for example on a variable with no value, it prints what it had resolved so far, and the graph shows that.

If several profiles in `~/.databrickscfg` point at the same workspace, the CLI refuses to choose one. The graph then lists the matching profiles with a **Choose profile** button; your choice is saved in your user settings (`databricksBundleInspector.profile`) and the target is checked again. To change it later, run **Choose Databricks Login Profile** from the Command Palette. The structural preview doesn't use a profile.

### Signing in for a target

When a target you picked can't be checked because you aren't signed in to its workspace, or your sign-in has expired, the graph says **Couldn't check dev. Sign in to try again.** and keeps showing the structural preview, which stays usable. The same shows on the sidebar's **Open Graph** row, with a key icon.

1. **Open Sign-in Terminal** (or the key icon) opens a terminal named *Databricks sign-in* with the Databricks CLI's standard sign-in command typed in, the same command as in the Databricks docs: `databricks auth login --host "<workspace>" --profile "<name>"`. It isn't run: you read it and press Enter.
2. Your browser opens the Databricks sign-in page for that workspace. After you sign in, the CLI saves a profile with that name in `~/.databrickscfg` (or the file `DATABRICKS_CONFIG_FILE` names), keeps a copy of the old file next to it as `.bak` (a relative `DATABRICKS_CONFIG_FILE` is from the bundle's folder, as the checks run the CLI there), and keeps the sign-in itself on your computer (in the OS keychain from CLI 1.0).
3. The graph then says **The Databricks CLI saved a sign-in.** Click **Check dev again** to check the target with it. Nothing is checked by itself. It doesn't say which profile was signed in, as the file doesn't always show it: signing in again to a profile that was already there leaves the file as it was.

Which workspace and profile name it types:

- The workspace is the target's `workspace.host`, else the bundle's. When it uses a variable, or there is none, you are asked for the workspace URL. A target's variable is never swapped for the bundle's own host.
- The profile is the one the checks use (the `databricksBundleInspector.profile` setting, else `DATABRICKS_CONFIG_PROFILE` in VS Code's environment, else the target's `workspace.profile`, the order the CLI uses), a profile that already signs in through the browser for that workspace, or else a new name made from the workspace (for example `adb-1234`). When neither the target nor the bundle has a `workspace.host` and nothing names a profile, it's `DEFAULT`: the CLI checks such a target with `DEFAULT` only, so a sign-in under another name wouldn't be used. A `DEFAULT` with a token, or for another workspace, isn't replaced; pick a profile in the Profile setting instead. When the profile the checks use is set with a variable, it types nothing, as only the CLI knows its value; set `databricksBundleInspector.profile` to sign in from the graph.
- It never types the name of a profile that signs in another way, for example with a token: signing in under that name would replace it. The graph says so instead, with **Check dev again** for once you've changed it. It also types nothing when the config file can't be read or written, or has a line the CLI can't read, and says why.
- It runs the Databricks CLI the checks use. When `databricksBundleInspector.cliPath` names a file that isn't called `databricks`, its path is typed instead.

To undo a sign-in, run `databricks auth logout --profile <name> --delete`, which removes that profile only.

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
| `databricksBundleInspector.inspectBundle` | Open Graph | Active file is `databricks.yml` or `databricks.yaml`, or a file the bundle's `include` loads |
| `databricksBundleInspector.openBundleIssues` | Open Bundle Issues | Command Palette; focuses issues for the active inspector bundle |
| `databricksBundleInspector.chooseProfile` | Choose Databricks Login Profile | Command Palette; lists the profiles in `~/.databrickscfg` and saves the one used when you pick a target |
| `databricksBundleInspector.checkAllBundles` | Check All Databricks Bundles Again | Command Palette and the sidebar's Bundles section; checks every bundle in the open folders, one at a time |
| `databricksBundleInspector.locateCli` | Locate the Databricks CLI… | Command Palette and the sidebar; pick the CLI file, saved to `databricksBundleInspector.cliPath` |
| `databricksBundleInspector.openCliInstallGuide` | Open the Databricks CLI Install Guide | Command Palette and the sidebar; the install steps for your OS |
| `databricksBundleInspector.chooseCli` | Choose the Databricks CLI… | Command Palette and the sidebar's CLI row; every Databricks CLI found, with its version and where it is from |
| `databricksBundleInspector.openGuide` | Open the Databricks Bundle Inspector Guide | Command Palette and the sidebar's `...` menu; this page, for your version |
| `databricksBundleInspector.reportIssue` | Report a Databricks Bundle Inspector Issue | Command Palette and the sidebar's `...` menu; a new GitHub issue |

## How it works

The extension runs `databricks bundle validate --output json` to resolve your bundle for the selected target. It then checks the local paths, libraries and pipeline sources the resolved config points at, and scans task notebooks and files for secrets and widgets. Nothing is deployed and your code is never run. That includes code a bundle can ask the CLI to run while it loads: shell commands under `experimental.scripts`, and Python under the `python` section. The extension tells the CLI not to run them. A bundle that uses them gets a warning saying so, and resources that only Python defines are not shown. The Databricks CLI uses your active profile and may contact your workspace to resolve the bundle, so `validate` can make network calls, and for a real target with a login it creates the target's empty files folder there if it is missing. Because the extension runs the CLI on the files you open, it is disabled in VS Code's Restricted Mode until you trust the folder. The checks that run by themselves, on open and on save, use a made-up target, which needs no login. The results become Problems panel entries and an interactive graph of jobs, tasks and pipelines, rendered with React Flow.

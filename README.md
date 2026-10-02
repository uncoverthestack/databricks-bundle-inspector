# Databricks Bundle Inspector

A VS Code extension that catches Databricks bundle errors before you deploy. It checks your Declarative Automation Bundle (formerly Databricks Asset Bundle) for the mistakes `databricks bundle validate` lets through, puts them in the Problems panel at the exact line, and shows your jobs and pipelines as an interactive graph.

Available on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=UncoverTheStack.databricks-bundle-inspector) and on [Open VSX](https://open-vsx.org/extension/UncoverTheStack/databricks-bundle-inspector) for Cursor and Windsurf.

## What it catches

Open a `databricks.yml` file and run **Inspect Databricks Bundle**. Every issue links to the file and line it comes from.

- **Missing local files**: notebooks and files referenced by tasks that don't exist, including the inner task of a `for_each` task.
- **Missing libraries**: local wheels and JARs a task installs that aren't there.
- **Pipeline sources**: Lakeflow Spark Declarative Pipelines (formerly Delta Live Tables, DLT) whose `libraries` point at a missing notebook or file, or at a `folder/**` glob with no files. The CLI doesn't check these during validation, so they otherwise surface only on `bundle deploy`.
- **Notebook and file mix-ups**: a notebook path without its extension, a notebook task pointing at a file without the notebook header, or a Python or SQL file task pointing at a notebook, following the Databricks CLI's rules.
- **Files that won't be deployed**: a task or pipeline pointing at a file that `.gitignore` or `sync.exclude` keeps out of `bundle deploy`.
- **`include` mistakes**: an `include` pattern that matches no files because of a likely typo (a misspelled folder, or `.yml` where the files end in `.yaml`), and a YAML file that defines resources but isn't in the include list. The CLI loads only what `include` selects and says nothing about the rest, so the bundle just has fewer jobs than you expect.
- **Widget parameters**: a notebook reading a widget that neither the task nor the job passes and that has no default, including through `%run` and across Python and SQL cells.
- **Task values**: `dbutils.jobs.taskValues.get(...)` or `{{tasks.<task>.values.<key>}}` reading from a task that doesn't exist, isn't upstream, or doesn't set that key.
- **Secret scope mix-ups**: code that reads a secret using the scope's resource key instead of its name, which fails at runtime.
- **Unresolved variables**: `${var.*}` values with no default and no value for the selected target.
- **Databricks CLI diagnostics**: validation errors and warnings, including unknown or deprecated fields, sent to the Problems panel.
- **Risky patterns**: task types the inspector doesn't recognise, and tasks that load code from Git when the job has no `git_source`.

### Code it reads

Checks on code (secrets, widgets, task values) read **Python and SQL**:

- `.py` and `.sql` files, Jupyter notebooks (`.ipynb`), and Databricks source-format notebooks.
- `%python` and `%sql` cells inside a notebook of the other language, each read in its own language.
- `dbutils` wherever it can be traced: `dbutils` itself (also as `self.dbutils`), a variable assigned from it, `DBUtils(spark)` or `get_dbutils(spark)`, imports under another name, and the Databricks SDK (`WorkspaceClient().dbutils`, `w.secrets.get_secret(...)`). A call on something that can't be traced, such as a function parameter named `d`, isn't counted; a widget read there makes the inspector say it couldn't check that notebook.

**Scala and R are not read.** `.scala` and `.r` notebooks, and `%scala` and `%r` cells, are skipped, so secrets, widgets and task values in them are not found. Markdown cells and other magic cells (`%md`, `%sh`, `%pip`) are not code and are skipped too.

## What it shows

- **Job graph**: tasks and their `depends_on` relationships, with pan, zoom and search. Hover a job's trigger to read its cron schedule in plain English.
- **Task details**: type, source file, parameters, compute, and linked pipelines with their catalog, schema and channel.
- **Secrets and widgets**: secret scopes (`dbutils.secrets`, SQL `secret()`, and `{{secrets/...}}` in cluster config) and notebook widgets found in each task's code.
- **Targets**: switch between the bundle's targets to see variables and issues resolved for each one.
- **Review summary**: copy a Markdown summary of the bundle and its issues for a pull request or code review.

<div>
    <a href="https://www.loom.com/share/634c3b8081f545b198e947ff68f99f3d">
      <p>Databricks Bundle Inspector Demo - Watch Video</p>
    </a>
    <a href="https://www.loom.com/share/634c3b8081f545b198e947ff68f99f3d">
      <img style="max-width:300px;" src="https://cdn.loom.com/sessions/thumbnails/634c3b8081f545b198e947ff68f99f3d-8b76e3bf25272d13-full-play.gif#t=0.1">
    </a>
  </div>

## Requirements

The inspector runs `databricks bundle validate`, so it needs the [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/install) installed and on your `PATH`, or set with the `databricksBundleInspector.cliPath` VS Code setting. The legacy `databricks-cli` pip package is a different tool and doesn't work.

If the CLI can't be found, the inspector says why (not installed, a wrong `cliPath`, or the legacy package on your `PATH`) and links to the install steps for your OS.

Tested with Databricks CLI `v0.299.0` and newer. With an older CLI the inspector still runs, but shows a warning, because results may be incomplete. A weekly check runs the inspector against the latest CLI release, so changes in its output are caught soon after they ship.

After installing the CLI, restart VS Code if the install added a new folder to your `PATH` (for example WinGet on Windows, or a first-time Homebrew install). Setting `databricksBundleInspector.cliPath` to the CLI's full path works without a restart.

## Usage

1. Open a folder containing a `databricks.yml` or `databricks.yaml` file.
2. Open the bundle file in the editor.
3. Click **Inspect Databricks Bundle** (editor title bar button) or right-click and select the command.

The graph opens in a new editor panel. It refreshes automatically when you save the bundle file or related configurations.

## Command

| Command ID | Title | When available |
| --- | --- | --- |
| `databricksBundleInspector.inspectBundle` | Inspect Databricks Bundle | Active file is named `databricks.yml` or `databricks.yaml` |
| `databricksBundleInspector.openBundleIssues` | Open Bundle Issues | Command Palette; focuses issues for the active inspector bundle |

## How it works

The extension runs `databricks bundle validate --output json` to resolve your bundle for the selected target. It then checks the local paths, libraries and pipeline sources the resolved config points at, and scans task notebooks and files for secrets and widgets. Nothing is deployed and your code is never run. The Databricks CLI uses your active profile and may contact your workspace to resolve the bundle, so `validate` can make network calls. Because the extension runs the CLI on the files you open, it is disabled in VS Code's Restricted Mode until you trust the folder. The results become Problems panel entries and an interactive graph of jobs, tasks and pipelines, rendered with React Flow.

## Telemetry

The extension collects anonymous usage data to learn which features are used and where people get stuck. You are told once, the first time it runs with telemetry on.

**To turn it off**, use either setting:

- `databricksBundleInspector.telemetry.enabled`: set to `false` to turn off telemetry for this extension only.
- `telemetry.telemetryLevel`: anything other than `all` turns off usage data for VS Code and every extension that respects it, including this one.

Turning it off also deletes any events still waiting to be sent, and stops the uninstall event.

- **Collected:** which features are used (inspecting a bundle, switching jobs or targets, opening files from the graph, copying the review summary), how an inspection turned out (for example "Databricks CLI not found"), why the Databricks CLI couldn't be used, whether it is older than the oldest tested version, coarse bundle size ranges (for example "6-20 tasks"), which Databricks task types appear (for example `notebook_task`), and a one-time event when the extension is uninstalled.
- **Environment:** extension and VS Code version, OS, OS version and CPU type (for example `darwin`, `25.0.0`, `arm64`), and remote type (for example WSL or SSH).
- **Never collected:** file paths or contents, bundle, job, task or target names, workspace hosts, search text, or error messages.
- **Identity:** an anonymous per-install ID, a one-way hash of VS Code's machine ID (never the ID itself). No accounts, no IP address, no location.
- **Offline:** events wait on your machine (up to 500, for at most 14 days) and are sent when you are back online.
- **Where it goes:** events are sent to a small proxy run by this project ([telemetry-proxy/](./telemetry-proxy)). The proxy drops anything not listed in `telemetry.json` and forwards the rest to PostHog. The extension itself contains no analytics keys.

Every event and property is listed in [telemetry.json](./telemetry.json). To see events as they are sent, run **Developer: Set Log Level…** → **Trace**, then open the **Output** panel and pick the extension's telemetry channel.

## Project status

Version 0.1.8. Active development. Feedback, bug reports, and feature requests are welcome on the [issue tracker](https://github.com/uncoverthestack/databricks-bundle-inspector/issues).

## License

Apache-2.0. See [LICENSE](./LICENSE).

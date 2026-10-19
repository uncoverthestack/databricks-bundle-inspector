# Databricks Bundle Inspector

A VS Code extension that catches Databricks bundle errors before you deploy. It checks your Declarative Automation Bundle (formerly Databricks Asset Bundle) for the mistakes `databricks bundle validate` lets through, puts them in the Problems panel at the exact line, and shows your jobs and pipelines as an interactive graph.

Available on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=UncoverTheStack.databricks-bundle-inspector) and on [Open VSX](https://open-vsx.org/extension/UncoverTheStack/databricks-bundle-inspector) for Cursor and Windsurf.

<div>
    <a href="https://www.loom.com/share/634c3b8081f545b198e947ff68f99f3d">
      <p>Databricks Bundle Inspector Demo - Watch Video</p>
    </a>
    <a href="https://www.loom.com/share/634c3b8081f545b198e947ff68f99f3d">
      <img style="max-width:300px;" src="https://cdn.loom.com/sessions/thumbnails/634c3b8081f545b198e947ff68f99f3d-8b76e3bf25272d13-full-play.gif#t=0.1">
    </a>
  </div>

## What it catches

Problems that pass `databricks bundle validate` and only fail when you deploy or run the job:

- **Missing files and libraries** that tasks and pipelines point at.
- **Files that won't be deployed**, because `.gitignore` or `sync.exclude` skips them.
- **`include` mistakes**: a pattern with a typo, or a resource file no pattern covers.
- **Notebook and file mix-ups**: a path without its extension, or a notebook where a file is expected.
- **Widgets** a notebook reads that the task doesn't pass.
- **Task values** read from a task that isn't upstream, or that never sets them.
- **Secret scopes** named by their resource key instead of their name.
- **Unresolved variables** for the selected target.

Where it can, it suggests the fix: "Did you mean `resources/*.yml`?" Checks on code read Python and SQL. Scala and R are not read.

[Every check, and what code is read](docs/checks.md)

## What it shows

- **Job graph**: tasks and what they depend on, with pan, zoom and search.
- **Task details**: type, source file, parameters, compute and linked pipelines.
- **Secrets and widgets** found in each task's code.
- **Targets**: pick a target in the graph to see its variables and issues resolved for it. The Problems panel keeps showing the structural preview, which needs no login.
- **Review summary**: copy a Markdown summary of the bundle and its issues for a pull request.

## Getting started

1. Install the [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/install), `v0.299.0` or newer.
2. Open a folder that contains a `databricks.yml` or `databricks.yaml`. The extension checks the bundle by itself, lists what it finds in the **Problems** panel, shows the count in the status bar, and checks again every time you save.
3. For the graph, open the bundle file and click **Inspect Databricks Bundle** in the editor title bar.

If the CLI can't be found, Inspect says why and links to the install steps for your OS. After installing it, restart VS Code so it sees the new `PATH`, or click **Locate CLI…** and pick the CLI file.

[Setup and usage in detail](docs/usage.md)

## Safety

- It runs one program, the Databricks CLI you installed, to validate the bundle. Nothing is deployed and your code is never run, including scripts and Python a bundle asks the CLI to run.
- It writes nothing into your bundle folder, not even the `.databricks` folder the CLI creates for a real target.
- It stays off until you tell VS Code you trust the folder.
- The checks that run by themselves need no login. Picking a real target in the graph uses your active CLI profile, or the one set in `databricksBundleInspector.profile`, and may contact your workspace.

See the [security policy](SECURITY.md).

## Telemetry

The extension collects usage data, such as which features are used. Never file paths, names or contents. Nothing is sent until you have closed the notice about it and opened VS Code again.

To turn it off, use either setting:

- `databricksBundleInspector.telemetry.enabled`: set to `false`, for this extension only.
- `telemetry.telemetryLevel`: anything other than `all`, for VS Code and every extension that respects it.

[What is collected, and where it goes](docs/telemetry.md)

## Project status

Version 0.3.1. Active development. Feedback, bug reports, and feature requests are welcome on the [issue tracker](https://github.com/uncoverthestack/databricks-bundle-inspector/issues).

## License

Apache-2.0. See [LICENSE](./LICENSE).

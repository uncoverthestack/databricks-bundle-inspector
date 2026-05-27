# Databricks Bundle Inspector

A VS Code extension that visualizes Databricks Bundles as interactive job dependency graphs. See the actual structure of your bundle jobs, task dependencies, and configurations at a glance.

## What it does

Open a `databricks.yml` file and run **Inspect Databricks Bundle** to see:

- **Visual DAG**: Interactive graph of jobs and `depends_on` relationships with pan, zoom, and search.
- **Task details**: Type, source file, parameters, compute, and dependencies.
- **Issue detection**: Missing files, unresolved variables, unknown task types, and Databricks CLI diagnostics.
- **Layout controls**: Automatic graph layout to keep parallel branches visually separated.

<div>
    <a href="https://www.loom.com/share/634c3b8081f545b198e947ff68f99f3d">
      <p>Databricks Bundle Inspector Demo - Watch Video</p>
    </a>
    <a href="https://www.loom.com/share/634c3b8081f545b198e947ff68f99f3d">
      <img style="max-width:300px;" src="https://cdn.loom.com/sessions/thumbnails/634c3b8081f545b198e947ff68f99f3d-8b76e3bf25272d13-full-play.gif#t=0.1">
    </a>
  </div>

## Requirements

The [Databricks CLI](https://docs.databricks.com/dev-tools/cli/index.html) must be installed and available on your `PATH`, or configured via the `databricksBundleInspector.cliPath` VS Code setting.

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

The extension runs `databricks bundle validate --output json` to resolve your bundle structure, builds a dependency graph from the jobs and their `depends_on` relationships, and renders it as an interactive visual DAG using React Flow.

## Project status

Version 0.1.2. Active development. Feedback, bug reports, and feature requests are welcome on the [issue tracker](https://github.com/uncoverthestack/databricks-bundle-inspector/issues).

## License

Apache-2.0. See [LICENSE](./LICENSE).

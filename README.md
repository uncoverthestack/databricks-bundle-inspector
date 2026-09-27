# Databricks Bundle Inspector

A VS Code extension that visualizes Databricks Bundles as interactive job dependency graphs. See the actual structure of your bundle jobs, task dependencies, and configurations at a glance.

## What it does

Open a `databricks.yml` file and run **Inspect Databricks Bundle** to see:

- **Visual DAG**: Interactive graph of jobs and `depends_on` relationships with pan, zoom, and search.
- **Task details**: Type, source file, parameters, compute, and dependencies.
- **Issue detection**: Missing files, unresolved variables, and Databricks CLI diagnostics, linked to the file and line they come from.
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

Tested with Databricks CLI `v0.299.0` and newer. A weekly check runs the inspector against the latest CLI release, so changes in its output are caught soon after they ship.

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

## Telemetry

The extension collects anonymous usage data to learn which features are used and where people get stuck. You are told once, the first time it runs with telemetry on.

**To turn it off**, use either setting:

- `databricksBundleInspector.telemetry.enabled`: set to `false` to turn off telemetry for this extension only.
- `telemetry.telemetryLevel`: anything other than `all` turns off usage data for VS Code and every extension that respects it, including this one.

Turning it off also deletes any events still waiting to be sent, and stops the uninstall event.

- **Collected:** which features are used (inspecting a bundle, switching jobs or targets, opening files from the graph, copying the review summary), how an inspection turned out (for example "Databricks CLI not found"), coarse bundle size ranges (for example "6-20 tasks"), which Databricks task types appear (for example `notebook_task`), and a one-time event when the extension is uninstalled.
- **Never collected:** file paths or contents, bundle, job, task or target names, workspace hosts, search text, or error messages.
- **Identity:** a random, anonymous per-install ID. No accounts, no IP-based location.
- **Offline:** events wait on your machine (up to 500, for at most 14 days) and are sent when you are back online.
- **Where it goes:** events are sent to a small proxy run by this project ([telemetry-proxy/](./telemetry-proxy)). The proxy drops anything not listed in `telemetry.json` and forwards the rest to PostHog. The extension itself contains no analytics keys.

Every event and property is listed in [telemetry.json](./telemetry.json). To see events as they are sent, run **Developer: Set Log Level…** → **Trace**, then open the **Output** panel and pick the extension's telemetry channel.

## Project status

Version 0.1.3. Active development. Feedback, bug reports, and feature requests are welcome on the [issue tracker](https://github.com/uncoverthestack/databricks-bundle-inspector/issues).

## License

Apache-2.0. See [LICENSE](./LICENSE).

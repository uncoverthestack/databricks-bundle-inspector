# Databricks Bundle Inspector

A VS Code extension that turns a `databricks.yml` or `databricks.yaml` file into an interactive, node-based graph of the jobs and tasks it defines. It runs `databricks bundle validate` under the hood, so the graph always reflects the real, fully-resolved bundle the CLI would deploy, not just a shallow parse of the YAML.

## What it does

Databricks Asset Bundles (DABs) describe jobs, tasks, dependencies, and compute in YAML that can span many files and layers of variable substitution. Reading the raw YAML rarely tells you what will actually run. This extension closes that gap inside your editor.

Open a `databricks.yml` file, run **Inspect Databricks Bundle**, and you get:

A visual DAG of every job in the bundle. Tasks are laid out left to right by dependency depth, with arrows showing `depends_on` relationships. A summary card in the top-left shows the job name, trigger, run-as identity, task count, parameters, and compute. Clicking any task opens a detail panel with its type, local path, compute targets, and task parameters. If the bundle defines multiple jobs, a dropdown lets you switch between them without re-running the command.

The graph is powered by React Flow and includes pan, zoom, a minimap, and layout controls out of the box.

## Requirements

The [Databricks CLI](https://docs.databricks.com/dev-tools/cli/index.html) must be installed and on your `PATH`. The extension looks for it in this order:

1. The `DATABRICKS_CLI_PATH` environment variable, if set.
2. `/opt/homebrew/bin/databricks` (the default Homebrew install path on Apple Silicon).
3. `databricks` on the system `PATH`.

Databricks authentication is not strictly required. If credentials are not configured, the extension will still render the graph and surface the auth warning in the console. Validation runs with a 30 second timeout.

## Usage

1. Open a folder that contains a `databricks.yml` or `databricks.yaml` file.
2. Open the bundle file in the editor.
3. Run the command from any of these entry points:
   * The **Inspect Databricks Bundle** button in the editor title bar (only shown for bundle files).
   * Right-click in the editor and choose **Inspect Databricks Bundle**.
   * The Command Palette: `Databricks Bundle Inspector: Inspect Databricks Bundle`.

The webview opens in a new editor column and hot-reloads if you re-run the command after editing the YAML.

## Commands

| Command ID | Title | When available |
| --- | --- | --- |
| `databricksBundleInspector.inspectBundle` | Inspect Databricks Bundle | Active file is named `databricks.yml` or `databricks.yaml` |

## How it works

The extension is split into two halves that talk over VS Code's webview message channel:

The **extension host** (`src/extension/`) resolves the Databricks CLI, invokes `databricks bundle validate --output json` in the bundle directory, and passes the parsed result to the webview. Validation warnings, auth failures, and timeouts are surfaced as VS Code notifications with structured error codes (`CLI_NOT_FOUND`, `CLI_NOT_EXECUTABLE`, `VALIDATION_TIMEOUT`, `AUTH_NOT_CONFIGURED`, `VALIDATION_FAILED`).

The **webview** (`src/webview/`) is a React 19 + Vite + Tailwind v4 app that receives the parsed bundle, builds a graph model via `extractBundleGraph`, and renders it with `@xyflow/react`. Layout is computed with a topological level assignment and a row-packing heuristic so parallel branches stay visually separated.

The graph model itself lives in `src/shared/bundleGraph.ts` and is imported by both sides, which keeps the node and edge shapes in sync.

## Development

```bash
npm install
npm run build       # builds the extension and the webview
npm run watch:esbuild    # rebuild the extension on change
npm run watch:tsc        # type-check the extension on change
npm run test             # run the Node test suite
npm run lint
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded. Sample bundles for manual testing live in `src/sample-data/`.

## Project status

Version 0.0.1. Active development. Feedback, bug reports, and feature requests are welcome on the [issue tracker](https://github.com/uncoverthestack/databricks-bundle-inspector/issues).

## License

Apache-2.0. See [LICENSE](./LICENSE).

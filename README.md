# Databricks Bundle Inspector

A VS Code extension for inspecting Declarative Automation Bundles (previously known as Databricks Asset Bundles) before you deploy or review them. It runs `databricks bundle validate --output json`, turns the CLI-resolved bundle into an interactive job graph, and surfaces bundle issues in context.

## What it does

Declarative Automation Bundles (previously known as Databricks Asset Bundles) (DABs) describe jobs, tasks, dependencies, and compute in YAML that can span many files and layers of variable substitution. Reading the raw YAML rarely tells you what will actually run. This extension closes that gap inside your editor.

Open a `databricks.yml` file, run **Inspect Databricks Bundle**, and you get:

- A visual DAG for bundle jobs, with arrows for `depends_on` relationships.
- Task details including type, source file, parameters, compute, dependencies, and direct dependents.
- Bundle issue detection for missing local files/libraries, unresolved variables, unknown task types, and Databricks CLI diagnostics.
- File-content enrichment for local task files, including detected secret scopes and widgets where supported.

The graph is powered by React Flow and includes pan, zoom, a minimap, search, job switching, issue-focused views, and layout controls.

## Requirements

The [Databricks CLI](https://docs.databricks.com/dev-tools/cli/index.html) must be installed. The extension looks for it in this order:

1. The VS Code setting `databricksBundleInspector.cliPath`, if configured.
2. `databricks` on the system `PATH`.

Databricks authentication is not strictly required for structural inspection. The extension uses a probe target by default so it can often read the CLI-resolved bundle even when workspace credentials are not configured. Validation runs with a 30 second timeout.

## Usage

1. Open a folder that contains a `databricks.yml` or `databricks.yaml` file.
2. Open the bundle file in the editor.
3. Run a command from one of these entry points:
   * The **Inspect Databricks Bundle** button in the editor title bar (only shown for bundle files).
   * Right-click in the editor and choose an inspector command.
   * The Command Palette.

The webview opens in a new editor column and hot-reloads if you re-run the command after editing the YAML.

## Commands

| Command ID | Title | When available |
| --- | --- | --- |
| `databricksBundleInspector.inspectBundle` | Inspect Databricks Bundle | Active file is named `databricks.yml` or `databricks.yaml` |
| `databricksBundleInspector.openBundleIssues` | Open Bundle Issues | Command Palette |

## How it works

The extension is split into two halves that talk over VS Code's webview message channel:

The **extension host** (`src/extension.ts`) resolves the Databricks CLI, invokes `databricks bundle validate --output json` in the bundle directory, builds diagnostics/issues, enriches the graph from local task files, and passes the parsed result to the webview. Validation warnings, auth failures, and timeouts are surfaced as VS Code notifications or Problems panel diagnostics.

The **webview** (`src/webview/`) is a React 19 + Vite + Tailwind v4 app that receives the parsed bundle graph and renders it with `@xyflow/react`. Layout is computed with a topological level assignment and a row-packing heuristic so parallel branches stay visually separated.

The bundle graph model lives in `src/bundle/graph/`. Issue building, semantic graph export, documentation policy, and markdown rendering live under `src/bundle/`.

## Development

```bash
npm install
npm run build          # builds the extension and the webview
npm run watch:esbuild  # rebuild the extension on change
npm run watch:tsc      # type-check the extension on change
npm run verify         # unit tests, semantic baselines, typecheck, lint
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded. Sample bundles for manual testing live in `src/sample-data/`.

## Testing

The test suite is split by confidence layer:

| Command | Purpose |
| --- | --- |
| `npm run test:unit` | Pure unit tests for parsers, graph extraction, issue building, documentation policy, and file-content detection. |
| `npm run test:semantic` | Golden semantic graph baseline tests from committed Databricks CLI-shaped JSON fixtures. |
| `npm run test:semantic:cli` | Live Databricks CLI compatibility check. Runs the configured CLI against a fixture and compares the resulting semantic graph to the committed baseline. |
| `npm run test:semantic:cli:matrix` | Runs the live CLI compatibility check across the CLI/fixture pairs in `semantic-cli-matrix.config.json`. |
| `npm run test` | Runs unit tests and semantic graph baselines. |
| `npm run typecheck` | Runs TypeScript without emitting build output. |
| `npm run lint` | Runs ESLint over `src`. |
| `npm run verify` | Local pre-PR check: tests, semantic baselines, typecheck, and lint. |

Semantic graph baselines intentionally use committed `validated-bundle.json`
fixtures that represent `databricks bundle validate --output json` output. They
do not parse raw YAML directly and normal tests do not overwrite fixture files.

To check a real Databricks CLI version without overwriting committed fixtures:

```bash
npm run test:semantic:cli
```

By default this runs `databricks` against
`src/test/fixtures/secret-scope-example` and compares the resulting semantic
graph with `src/test/fixtures/baselines/secret-scope-example.semantic.json`.
Use environment variables to point it at another CLI or fixture:

```bash
SEMANTIC_CLI_COMMAND=/usr/local/bin/databricks \
SEMANTIC_CLI_FIXTURE=src/test/fixtures/secret-scope-example \
SEMANTIC_CLI_BASELINE=src/test/fixtures/baselines/secret-scope-example.semantic.json \
npm run test:semantic:cli
```

Live CLI artifacts are written under `.test-artifacts/semantic-cli/` for
inspection and are ignored by git. This command is intentionally not part of
`npm run verify` because it depends on an external CLI installation and local
Databricks environment behavior.

To run the compatibility check across multiple CLI commands and fixtures:

```bash
npm run test:semantic:cli:matrix
```

The default matrix lives in `semantic-cli-matrix.config.json`. It is deliberately
small so it works in a normal local environment. For broader compatibility
testing, provide a separate config whose `clis` entries point at pinned
Databricks CLI binaries, for example:

```json
{
  "clis": [
    { "name": "0.270.1", "command": "/opt/databricks-cli/0.270.1/databricks" },
    { "name": "0.295.0", "command": "/opt/databricks-cli/0.295.0/databricks" },
    { "name": "latest", "command": "/usr/local/bin/databricks" }
  ],
  "fixtures": [
    {
      "name": "secret-scope-example",
      "fixture": "src/test/fixtures/secret-scope-example",
      "baseline": "src/test/fixtures/baselines/secret-scope-example.semantic.json"
    }
  ]
}
```

Run it with:

```bash
npm run test:semantic:cli:matrix -- --config path/to/matrix.json
```

The intended compatibility floor for v0 is Databricks CLI `v0.270.1+`, but broad
compatibility claims should be tied to the fixture suite covered by this matrix.

To install a local matrix of pinned Databricks CLI binaries from GitHub releases:

```bash
npm run cli:install-matrix -- --min 0.270.1
```

This installs every Databricks CLI release at or above the minimum into
`.tools/databricks-cli/` and writes `semantic-cli-matrix.local.json`. Then run:

```bash
npm run test:semantic:cli:matrix -- --config semantic-cli-matrix.local.json
```

For a faster smoke matrix, use:

```bash
npm run cli:install-matrix -- --min 0.270.1 --strategy latest-patch-per-minor
```

The smoke strategy is useful for quick local checks, but it should not be used
as the compatibility claim for v0.

To intentionally refresh a validated bundle fixture and its provenance metadata:

```bash
npm run fixtures:update:validated-bundle -- \
  --fixture src/test/fixtures/secret-scope-example \
  --cli databricks
```

This command writes both `validated-bundle.json` and
`validated-bundle.meta.json`. The metadata includes the CLI version, generation
timestamp, target, and a canonical SHA-256 of the JSON payload so formatting-only
changes do not invalidate provenance.

## Dev Container

The repository includes a VS Code dev container for repeatable local checks. It
uses Node 22, installs project dependencies with `npm ci`, and installs the
Databricks CLI inside the container.

Recommended workflow:

1. Open the repository in VS Code.
2. Run **Dev Containers: Reopen in Container**.
3. Run deterministic checks:

   ```bash
   npm run verify
   ```

4. Run the live CLI semantic compatibility check inside the container:

   ```bash
   npm run test:semantic:cli
   ```

The dev container sets `databricksBundleInspector.cliPath` to
`/usr/local/bin/databricks` for extension development hosts launched from the
container.

## Project status

Version 0.1.0. Active development. Feedback, bug reports, and feature requests are welcome on the [issue tracker](https://github.com/uncoverthestack/databricks-bundle-inspector/issues).

## License

Apache-2.0. See [LICENSE](./LICENSE).

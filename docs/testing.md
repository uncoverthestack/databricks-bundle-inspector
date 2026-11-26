# Which tests to run

There are many test commands. Most of them CI runs for you. This page says which ones to run yourself, and when.

## Before every pull request

```sh
npm run verify
```

This runs the unit tests, the semantic graph test, the type check, lint and the changelog check, in under a minute. It needs no Databricks CLI and no sign-in. If it passes, the rest of CI usually does too.

If `verify` fails on a file that isn't in the repository, such as something in a git-ignored folder, that's a bug in the tooling: report it.

## What CI runs for you

You don't need to run these locally unless one fails on your pull request.

| Check on the pull request | What it runs | When |
| --- | --- | --- |
| **CI**: Build, Test, Lint, Audit | Unit tests with coverage floors, semantic test, lint, webview type check, changelog check, build | Every pull request |
| **CI**: Test (Windows) | Unit tests on Windows | Every pull request |
| **CI**: CLI package | Builds and packs the command-line tool on each OS | Every pull request |
| **Databricks CLI compatibility** | The suites under "Through a real Databricks CLI" below, on Databricks CLI 0.299.2 and the latest | Every pull request, the merge queue, Mondays |
| **Findings on real bundles** | The inspector before and after your change on about 870 real bundles | Pull requests that change the checks or the command-line tool |
| **E2E** | Every VS Code end-to-end suite on Windows, Linux and macOS | The merge queue and releases (on a pull request only its summary job runs) |
| **Databricks Runtime dates** | Runtime end-of-support dates against the Databricks docs | Pull requests that touch them, weekly |

None of them signs in to a Databricks workspace.

## When you changed something, also run

| You changed | Run |
| --- | --- |
| Anything | `npm run verify` |
| How the inspector reads Databricks CLI output | `npm run test:semantic:cli` (needs the `databricks` CLI on your PATH) |
| Variables or targets | `npm run test:variables:cli` |
| Notebook detection | `npm run test:notebook-rule:cli` |
| Panel, graph or overview (`src/webview/`) | The matching E2E suite, see [Running end-to-end tests](e2e-tests.md) |
| A check | Follow [Adding a check](adding-a-check.md): live probe with `npm run live-rules`, near-miss test, corpus check |
| The command-line tool (`src/cli/`) | `npm run build:cli`, then `node cli/dist/cli.cjs check <folder>` |
| A recorded fixture's bundle | `npm run fixtures:update:validated-bundle -- --fixture <folder>` |

## Tests that need a sign-in

CI never signs in, so these only run when you set a profile from your `~/.databrickscfg`. Run them before a release and after changing anything about real targets or sign-in.

```sh
INSPECTOR_TEST_PROFILE=<profile> npm run test:semantic:cli
INSPECTOR_TEST_PROFILE=<profile> npm run test:variables:cli
npm run test:e2e:targets -- --profile <profile>
```

Without a profile, these tests are skipped, not failed. They don't deploy anything, but the Databricks CLI creates empty folders under `.bundle` in your workspace home: `real-paths`, `shadow`, `varpath`, `targets-e2e` and `dbi-variables-it`. Delete them afterwards.

## Every command

### Build

| Command | What it does |
| --- | --- |
| `npm run build` | Extension and webview into `dist/` |
| `npm run build:ext` | Extension only (`compile` is the same) |
| `npm run build:webview` | Webview only |
| `npm run build:cli` | Command-line tool into `cli/dist/` |
| `npm run build:e2e`, `build:corpus` | The E2E and corpus runners into `out/` (the commands that use them build them first) |
| `npm run watch:esbuild`, `watch:tsc`, `watch-tests` | Rebuild or type check on every save |
| `npm run package:vsix` | Packages `dist/` as a `.vsix`. It doesn't build first: run `npm run build` before |
| `npm run pack:cli` | Both npm packages of the command-line tool, as `.tgz` |

### Check

| Command | What it does |
| --- | --- |
| `npm run verify` | Everything to run before a pull request |
| `npm run test` | Unit tests and the semantic test |
| `npm run test:unit` | Unit tests |
| `npm run test:unit:coverage` | Unit tests with the coverage floors CI checks |
| `npm run test:semantic` | The semantic graph test, on recorded CLI output |
| `npm run typecheck`, `typecheck:webview` | Type check of `src/`, and of the webview |
| `npm run lint` | ESLint on `src/` |
| `npm run changelog:check` | Checks the files in `changes/` |

### Through a real Databricks CLI

| Command | What it does |
| --- | --- |
| `npm run test:semantic:cli` | Fixtures through the CLI on your PATH, plus the sign-in tests when a profile is set |
| `npm run test:semantic:cli:matrix` | The same on several CLI versions. Install them first with `npm run cli:install-matrix` |
| `npm run test:variables:cli` | Variable values per target, against a fake workspace (or yours, with a profile) |
| `npm run test:notebook-rule:cli` | Which files the CLI treats as notebooks |
| `npm run test:schema-coverage` | Every resource and task type in the CLI's schema is known to the inspector |
| `npm run test:recorded-fixtures:cli` | Recorded fixture output still matches the CLI |
| `npm run test:runtime-dates` | Runtime dates against the docs (reads the network) |
| `npm run check:pipeline-sql-reference` | Pipeline SQL reference list against the docs. `update:pipeline-sql-reference` rewrites it |
| `npm run live-rules -- --profile <p> --probe <code>` | Deploys and runs a check's probe bundles. See the [probes README](../src/test/liveRules/README.md) |

### VS Code end to end

`npm run test:e2e` and the 20 `test:e2e:*` commands each open VS Code on one suite. See [Running end-to-end tests](e2e-tests.md).

### Release and repairs

| Command | What it does |
| --- | --- |
| `npm run changelog:release` | Moves `changes/*.md` into the changelog, for a release |
| `npm run changelog:preview` | Shows the next release's notes |
| `npm run deps:repair-native` | Reinstalls a platform package that `npm ci` skipped |
| `npm run fixtures:update:validated-bundle` | Records a fixture's CLI output again |

## The Jest configs

Each `npm run` above picks its config. You only need these to run a single file, for example `npx jest --config jest.semantic-cli.config.cjs <file>`.

| Config | Used by |
| --- | --- |
| `jest.config.cjs` | `test:unit`, `test:semantic` |
| `jest.coverage.config.cjs` | `test:unit:coverage` |
| `jest.semantic-cli.config.cjs` | `test:semantic:cli`, `test:semantic:cli:matrix` |
| `jest.variables-cli.config.cjs` | `test:variables:cli` |
| `jest.notebook-rule.config.cjs` | `test:notebook-rule:cli` |
| `jest.schema-coverage.config.cjs` | `test:schema-coverage` |
| `jest.recorded-fixtures.config.cjs` | `test:recorded-fixtures:cli` |
| `jest.runtime-dates.config.cjs` | `test:runtime-dates` |

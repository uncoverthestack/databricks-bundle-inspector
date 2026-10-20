# Running end-to-end tests

These commands work in PowerShell, Command Prompt, and POSIX shells. Each builds
the extension and opens a separate VS Code instance for its suite.

| Suite | Command |
| --- | --- |
| Missing CLI | `npm run test:e2e` |
| Missing CLI, with pauses | `npm run test:e2e:watch` |
| Include mistakes | `npm run test:e2e:include` |
| Include mistakes, with pauses | `npm run test:e2e:include:watch` |
| Issue codes | `npm run test:e2e:issue-codes` |
| Resource files | `npm run test:e2e:resource-files` |
| Rendered graph refresh | `npm run test:e2e:graph-refresh` |
| Overlapping inspections (Linux/macOS) | `npm run test:e2e:inspection-races` |
| Automatic checks | `npm run test:e2e:always-on` |
| Automatic checks, with pauses | `npm run test:e2e:always-on:watch` |
| Saved files | `npm run test:e2e:saved-file` |
| Saved files, alternate folder case | `npm run test:e2e:saved-file:other-case` |
| Targets | `npm run test:e2e:targets` |

The alternate folder case test skips on case-sensitive file systems. Suites that
use the CLI require it on PATH; see each fixture's README for prerequisites.

The overlapping-inspections suite uses a shell wrapper around the real CLI to
control when checks finish. It covers switching bundles, switching jobs in one
bundle, switching during a save refresh, and closing a graph during an inspection.
It restores its settings and files, and is skipped on Windows because the wrapper
requires `/bin/sh`.

For target tests that need a login, pass a profile from your Databricks config:

```sh
npm run test:e2e:targets -- --profile DEFAULT
```

Extra arguments after `--` reach the runner through the named scripts. Supported
options are `--suite`, `--fixture` (relative to the repository root),
`--folder-case other`, `--pause-ms` (a non-negative integer), and `--profile`.
Quote values containing spaces. Arguments override the corresponding legacy
variables: `E2E_SUITE`, `E2E_FIXTURE`, `E2E_FOLDER_CASE`, `E2E_PAUSE_MS`, and
`INSPECTOR_TEST_PROFILE`. Without a suite, the runner uses `cliNotFound`; an
unknown suite fails and lists the valid names.

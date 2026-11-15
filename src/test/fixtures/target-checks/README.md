# Checks the CLI runs once a target is picked (#389)

One bundle per folder, each with one mistake. The inspector's structural preview validates with a target that doesn't exist, so the Databricks CLI stops at "no such target" before these checks run. `bundle validate` with no target, and sign-in blocked, does report them, and stops at the first error. That is why each case is its own bundle.

`targetChecks.integration.test.ts` runs each folder through the real CLI and the inspector, on every CLI in the CLI matrix, and says what each CLI version prints. Two folders must stay quiet: `clean`, and `secret-variable` (a secret done right). `script-escaped-variable` is fine from CLI v1.15.0 and rejected before it.

Checked on Databricks CLI v1.26.0 and v0.299.2, 2 runs each, on 2026-11-14.

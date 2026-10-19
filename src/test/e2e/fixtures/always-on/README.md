# always-on fixture

Opened as a folder by `npm run test:e2e:always-on`. The test never runs Inspect.

- `teams/sales/` is a bundle in a subfolder. Its `include` has a misspelled folder, which the inspector warns about.
- `teams/marketing/` is a second, clean bundle with one job and one task, so the status bar covers the whole folder. A test deletes `teams/sales/databricks.yml` (and puts it back) to check that a removed bundle is dropped and the item goes back to one bundle.
- `venv/templates/` holds the same bundle inside a folder the inspector skips, so it must get no warning.

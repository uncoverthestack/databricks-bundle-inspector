# always-on fixture

Opened as a folder by `npm run test:e2e:always-on`. The test never runs Inspect.

- `teams/sales/` is a bundle in a subfolder. Its `include` has a misspelled folder, which the inspector warns about.
- `venv/templates/` holds the same bundle inside a folder the inspector skips, so it must get no warning.

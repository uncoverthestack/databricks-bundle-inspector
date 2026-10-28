# Resource file edge cases

Run `npm run test:e2e:resource-files` with the Databricks CLI on `PATH`.

The workspace has three bundles. `alpha` also includes the file that the nested
`alpha/teams/sales` bundle loads. The parent uses `databricks.yml`, and the nested
bundle uses `databricks.yaml`, to check that the CLI uses the requested root.

The real VS Code tests cover repeated bundle switching, the job under the cursor,
a cursor after the jobs, the pipeline under the cursor, unrelated YAML, `files.exclude`, removing and restoring
an include, renaming a loaded file to a name with spaces and Unicode, path letter
case where the file system ignores it, and deleting a nested bundle while its
parent still loads the same resource file.

Tests restore edited files. No Databricks login is needed.

`npm run test:e2e:graph-refresh` also checks the rendered graph dropdown after
opening Bundle Issues, repeated saves, and refreshing the structural preview.
It uses Chromium's loopback debugging interface in the isolated test window.

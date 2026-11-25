# target-only-jobs

Jobs that only a target writes, for the "Jobs Not Checked" note in the panel's Issues list.

- `shared`: in `resources` and again in `dev`. Checked with no target picked, so no note.
- `nightly`: only in `prod`. Note: pick prod.
- `both`: in `dev` (databricks.yml) and in `prod` (resources/more.yml). One note naming both targets, at the `dev` line.

`validated-bundle.json` is the CLI's structural preview, `databricks bundle validate --output json -t __bundle_inspector_probe__`, captured with Databricks CLI v1.28.0 on 2026-11-25. With no target, `resources.jobs` has only `shared`; `targets.dev` and `targets.prod` keep their own jobs.

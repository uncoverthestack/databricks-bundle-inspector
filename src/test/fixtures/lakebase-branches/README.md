# Lakebase branches (issue 543)

A Lakebase project with branches made from each other and from a snapshot, for the branches page.

Checked on 2026-11-24 with CLI v1.28.0:

- `bundle validate --target __bundle_inspector_probe__` (the structural preview) prints the resources exactly as written: every `${resources...}` reference stays unresolved, so the YAML stands in for the CLI output in the tests.
- `bundle validate -t dev` passed. It resolved `branch_id: dev-${workspace.current_user.short_name}` to the user's short name, and `mode: development` left `project_id` unchanged.
- Nothing was deployed, so whether the workspace accepts each branch (for example a snapshot that doesn't exist) is not tested here.

What each resource tests:

| Resource | Written as | Page |
|---|---|---|
| `orders_db` | no `default_branch` | first branch is `production`, "Made with the project" |
| `dev` | `source_branch: ${resources.postgres_projects.orders_db.id}/branches/production`, `ttl` | under production, expires |
| `feature_x` | `source_branch: ${resources.postgres_branches.dev.id}`, `source_branch_lsn` | under dev, no read-write endpoint |
| `restore` | `source_snapshot` | in the snapshot section |
| `reports` | `parent: projects/finance-db`, a project the bundle doesn't define | keeps its own box on the overview |
| `prod_rw`, `app_db`, `app_owner`, `orders`, `daily` | on `.../branches/production` by path | held by production |
| `orders_app` | `postgres.database: ${resources.postgres_databases.app_db.id}` | uses production through app_db |

From the CLI schema: a branch with no `source_branch` is made from the project's default branch; snapshots are only taken on the project's root branch (CLI acceptance test `postgres_snapshot_schedules`).

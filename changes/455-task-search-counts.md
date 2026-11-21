Fixed

- **Task search and the Tasks panel show the same problems as the task's box** ([#455](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/455)). A task with a broken `depends_on`, or any other problem besides a missing file, library or variable, used to show no count in search and no mark in the Tasks panel. Search badges are now amber for warnings only, as the boxes are. Paths under `/Shared/`, `/Users/`, `/Repos/` and `/Volumes/` show REMOTE in the Files panel instead of UNKNOWN.

Fixed

- **Task boxes show every problem, in the right colour** ([#393](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/393)). A for-each task whose inner task has a missing file now has a red border, like other tasks with missing files. A task with only warnings has an amber border and a count. The tasks' counts now add up to the **Issues** count. Before, a box only counted missing files, libraries and variables, so warnings such as a git source never showed on it.

Added

- **A note when a job's environments use a variable and no target is picked** ([#687](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/687)): "Not checked: job "nightly"'s environments use a variable, so they aren't known yet. Pick a target in the graph to check it." The structural preview keeps the variable as text, so a misspelled `environment_key` in such a job can't be found until a target is picked. The command-line tool says "Use --target to check it." New code `environments_not_checked`.

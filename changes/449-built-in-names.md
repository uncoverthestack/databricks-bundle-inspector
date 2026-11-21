Fixed

- **A widget, variable or setting named `constructor`, `toString`, `hasOwnProperty` or `valueOf` no longer breaks the checks** ([#449](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/449)). Reading such a widget used to crash the checks and clear every problem from the Problems panel, including unrelated ones. A variable with one of these names, overridden in a target, stopped the bundle from showing at all. A widget created with one of these names turned off that notebook's widget checks, and `${var.toString}` with no such variable was not reported as unresolved.

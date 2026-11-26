Fixed

- **A job whose `environments` list is a variable no longer gets "Environment may not exist"** ([#679](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/679)) for its tasks' `environment_key` in the structural preview. The preview keeps a complex variable as text, so the job's environments aren't known there; pick a target to check them. Found by running the inspector over 200 public bundles on GitHub.

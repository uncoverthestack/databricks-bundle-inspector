Fixed

- **Databricks CLI recommendations are shown** ([#621](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/621)). `bundle validate` prints some advice as `Recommendation:` lines, such as "define a single job in a file with the .job.yml extension.", and the inspector left them out, so the bundle showed no problems. Each one is now a note at the file and line the CLI gives, in the Problems panel, the graph and the command-line report. Notes don't change `--fail-on error` or `--fail-on warning`. Checked on Databricks CLI v1.28.0.

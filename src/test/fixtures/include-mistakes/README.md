# include-mistakes

Fixture for the `include` checks. Built to be run through a real Databricks CLI, which
loads only `resources/top.job.yml`:

- `resources/jobs/nested.job.yml`: in a sub-folder, which `resources/*.yml` does not reach.
- `resources/legacy.job.yaml`: `.yaml`, which `resources/*.yml` does not match.
- `resource/*.yml`: a misspelled folder that matches nothing.
- `paused/job.yml`: left out on purpose and named in a comment, so it is not reported.

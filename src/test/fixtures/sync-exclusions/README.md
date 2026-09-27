# Sync exclusions

Tasks and pipelines that point at files `bundle deploy` does not upload. `databricks bundle validate` reports "Validation OK!" for this bundle (CLI v1.17.0), so these only fail when the job or pipeline runs. `databricks bundle sync --dry-run` uploads only `src/kept.py` and `src/readded.py` of the referenced files.

| Task or pipeline | File | Skipped by | Inspector |
|---|---|---|---|
| `gitignored` | `src/ignored.py` | `.gitignore` | May not be deployed: it matches .gitignore |
| `nested_gitignored` | `src/nested/nested_ignored.py` | `src/nested/.gitignore` | May not be deployed: it matches src/nested/.gitignore |
| `sync_excluded` | `src/excluded/e.py` | `sync.exclude` | May not be deployed: it matches sync.exclude |
| `readded_by_include` | `src/readded.py` | in `.gitignore`, added back by `sync.include` | No issue |
| `kept` | `src/kept.py` | not skipped | No issue |
| `sync_exclusions_pipeline` notebook | `src/excluded/pipeline_nb.py` | `sync.exclude` | May not be deployed: it matches sync.exclude |
| `git_sourced` job | `src/ignored.py` | job has `git_source`, so the file comes from Git | No issue |

The gitignored files are committed with `git add -f`, so the fixture keeps them.

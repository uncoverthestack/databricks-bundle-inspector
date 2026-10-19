# targets fixture

Opened as a folder by `npm run test:e2e:targets`.

`src/load.py` reads the widget `run_date`, which the job in `resources/job.yml` doesn't pass, so the structural preview warns. The tests check that the Problems panel keeps that warning whatever target the graph shows, and that nothing is written into this folder.

`databricks.yml` has no workspace host on purpose. To run the cases that need a login, name a profile from your `~/.databrickscfg`; the CLI takes the host from it:

```
INSPECTOR_TEST_PROFILE=<profile> npm run test:e2e:targets
```

Without it, only the cases that need no login run.

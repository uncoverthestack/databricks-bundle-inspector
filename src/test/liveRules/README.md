# Live rule probes

Many checks rest on what Databricks did when a small bundle was deployed and run on one Databricks CLI version. Databricks changes some of these between releases. The probes re-run them, so a change shows up as a failing run instead of a wrong finding (#650).

Each folder in `probes/` is one rule: `rule.json` says which finding code it backs and what each step does, and `broken/` and `working/` are the bundles. The working bundle is the control: it must deploy and run.

```sh
npm run live-rules -- --profile <profile>
npm run live-rules -- --profile <profile> --probe widget_removed_then_read --runs 1
```

- It deploys and runs real jobs (serverless), so it needs a sign-in and is never run in GitHub Actions.
- Each run uses its own bundle name. After each run it calls `bundle destroy`, deletes the run's `.bundle/<name>` folder and checks it is gone. Anything it couldn't remove is listed and fails the run.
- Steps marked `unknown` are rules not confirmed yet: the run says what happened without failing. Once two runs agree, write the step in `rule.json`, `docs/checks.md` and `src/bundle/checkList.ts` (#648).
- Run it on release day with the newest Databricks CLI, and after a CLI release that mentions bundles.

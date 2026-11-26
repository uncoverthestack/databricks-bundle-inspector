# Adding a check

[Back to the list of checks](checks.md)

The inspector is worth using only if its findings are right. Each check rests on what Databricks really does, so a new check, or a new case of an existing one, ships only once it meets the bar below.

## What to work on first

Rank new checks and changes by one question: **does it stop a wasted job run?**

The Databricks CLI never reads notebook or SQL code, and `bundle validate` and `bundle deploy` pass many mistakes that only fail once the job runs. Each of those costs a deploy and a job run to find, often hours later. The inspector is the only thing that catches them before then.

| Stops | Meaning | Priority |
|---|---|---|
| `run` | validate and deploy pass, the run fails | First |
| `silent` | it deploys and runs, but does something other than what is written | First |
| `deploy` | validate passes, deploy fails | Lower: deploy already says so, just later |
| `validate` | the CLI's own validate stops, with a real target | Lower: shown before a target is picked |
| `advice`, `coverage`, `cli` | nothing fails | Lowest, apart from security (for example a runtime past end of support) |

## The bar

All four are needed before a check ships. A unit test (`checkList.test.ts`, "the bar every check meets before it ships") fails for any code that isn't in `src/bundle/shippedCodes.json` yet and misses 1, 3 or 4.

1. **Its failing step is confirmed live.** Add a probe in `src/test/liveRules/probes/<code>/`: a `broken` bundle with the mistake and a `working` one, as close as possible, that deploys and runs. Run it at least twice on a test workspace with the newest Databricks CLI (`npm run live-rules -- --profile <profile> --probe <code>`, see the [probes README](../src/test/liveRules/README.md)). Only then write the steps in `rule.json`: the step the broken bundle fails at must be the one the check list names. Checks where nothing fails (`advice`, `coverage`, `cli`) need no probe.
2. **No new false alarms on real bundles.** The **Findings on real bundles** pull request check runs the inspector before and after the change on about 870 real bundles. Read every finding it adds. Add the `corpus-change-expected` label only once each new finding is a real problem; a single false alarm means the check is changed first.
3. **A near-miss test that must stay quiet.** A unit test titled `near miss (<code>): ...` with a case close to the mistake that gives no finding: `outcome: "true"` beside `"True"`, 5,000 characters beside 5,001, a table the pipeline does create. It stops a check from growing to catch correct bundles.
4. **An entry in the check list.** The code in `src/bundle/checkList.ts` with its family and the step it stops, and a section in [docs/checks.md](checks.md) saying what fails and how it was confirmed (CLI version and date).

A new case of an existing check (another field, another kind of file) meets the same bar for that case: a probe variant or a note of how it was confirmed live, the corpus check, and a near-miss case.

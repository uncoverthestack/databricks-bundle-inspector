# Stress test: changes after 0.5.0

Scope: `v0.5.0` through `6bd5ea5` on `review-report`, followed by the fixes in
this working tree. This covers the sidebar and workspace lifecycle, pipeline
views, file suggestions, telemetry changes, and the new full review report.
Other unmerged branches are outside this run.

## Confirmed findings and fixes

| # | Trigger and previous behavior | Fixed behavior |
|---|---|---|
| 1 | An 80,000-character job name produced a 160,450-character report, exceeding its advertised 60,000-character limit. | Metadata is bounded before sections consume the report budget. |
| 2 | A file-arrival URL containing both a backtick and a pipe bypassed table escaping. | Only deliberately formatted cron text bypasses plain-cell formatting. |
| 3 | A filename containing two consecutive backticks closed the report's two-backtick inline-code delimiter. | Code delimiters are longer than every backtick run in their content. |
| 4 | The full report read the graph's three-parameter summary, silently dropping later job parameters. | Parameters come from the complete parsed job. |
| 5 | A parameter table that exceeded the remaining report budget disappeared without an omission notice. | The notice explicitly names omitted job parameters. |
| 6 | A job called from inside a for-each task was described as started by hand or outside the bundle. | The Starts row detects the inner run-job task. |
| 7 | For-each notebook files were absent from the file count, file table and Runs column; inner pipeline references were absent from Runs too. | The report includes nested task references. |
| 8 | A single directory containing more files than the scan budget bypassed that budget. | The file limit is enforced inside the directory loop; the scan is marked incomplete. |
| 9 | A directory read failure was treated as a complete scan, potentially hiding a second matching filename. | Any unread folder makes the scan incomplete and disables moved-file suggestions. |
| 10 | Opening a resource whose YAML key was `null` or `~` selected the first resource instead. | Selection preserves the key spelling that the real CLI uses. Numeric and boolean keys remain unsupported, matching CLI rejection. |
| 11 | A quote inside a plain path followed by a YAML comment made the comment part of the path and suppressed the quick fix. | Quote handling starts at the scalar's actual column and respects plain-scalar rules. |

Regression coverage lives in `reviewReport.test.ts`, `pathSuggestions.test.ts`,
`resourceFiles.test.ts`, `quickFix.test.ts`, `pipelineView.integration.test.ts`,
and `pathSuggestion.integration.test.ts`. The last two verify resource-key and
quoted-path behavior against real CLI output, including applying the suggestion
and validating the resulting bundle.

## Validation results

| Check | Result |
|---|---|
| `npm run verify` | 1,034 tests passed; one pre-existing TODO. Type checking and lint passed. |
| Random dependency graphs | 20,000 seeded jobs matched the independent reachability reference. Dense 1,000-task performance case passed. |
| YAML path fuzzing | 1,000 generated strings round-tripped through three quote styles and YAML 1.1/1.2: 6,000 checks. |
| Concurrent check limiter | Three 1,000-check batches with 1, 2 and 8 slots; simulated failures released slots, FIFO order and concurrency limits held. |
| Report task boundaries | 0, 1, 49, 50, 51, 100 and 1,000 tasks; correct picture cutoff, report length, selected-job isolation and problem retention. |
| CLI integration compatibility | 36 tests passed per version on all 25 locally cached CLIs, plus CLI 1.21.0: 26 distinct versions. Eight credential-dependent cases skipped per run. |
| Semantic fixture matrix | All 12 fixture cases passed on CLI 1.21.0. This is separate from the per-version integration run. |
| Variable resolution | Eight integration tests passed against a local fake workspace. |
| VS Code end-to-end suites | 61 tests passed across eight suites; four credential-dependent target cases skipped. |
| Build and whitespace | Extension/webview/e2e builds and `git diff --check` passed. |

The 25 cached versions were 0.299.0, 0.299.1, 0.299.2, 1.0.0, 1.1.0, 1.2.0,
1.2.1, 1.3.0, 1.4.0, 1.5.0, 1.6.0, 1.7.0, 1.8.0, 1.9.0, 1.10.0, 1.11.0,
1.12.0, 1.12.1, 1.13.0, 1.14.0, 1.14.1, 1.15.0, 1.16.0, 1.16.1 and 1.17.0.

The UI suites were sidebar (11), graph refresh and copy review (3), workspace
changes (9), overlapping inspections (4), resource files (9), issue codes and
quick fixes (9), targets (7 passed / 4 skipped), and themes (9). The final issue
suite also exercised 900 unchecked-path notes through repeated edits in a
1,000-task job. It was rerun after the final quick-fix change.

## Reproduction

Run from the repository root:

```sh
npm run verify
RANDOM_RUNS=20000 npx jest src/test/unit/extension/jobStructure.random.test.ts --runInBand
npm run test:semantic:cli
npm run test:variables:cli
npm run test:semantic:cli:matrix
npm run test:e2e:sidebar
npm run test:e2e:graph-refresh
npm run test:e2e:workspace-changes
npm run test:e2e:inspection-races
npm run test:e2e:resource-files
npm run test:e2e:issue-codes
npm run test:e2e:targets
npm run test:e2e:themes
```

To repeat integration checks on a particular CLI, set `SEMANTIC_CLI_COMMAND` to
its **absolute** executable path before running `npm run test:semantic:cli`.
The tests run the CLI from temporary bundle directories, so a relative executable
path is insufficient. CLI tests require permission to bind their fake workspace
to loopback; UI tests require permission to launch the test VS Code application.

## Limits

- Run on macOS arm64. Windows and Linux behavior needs their CI runners.
- Credential-dependent target checks were skipped; no authenticated deployment
  behavior was established by this run.
- Mermaid source and copying were checked, but the copied diagram was not
  rendered by GitHub or GitLab.
- The existing TODO about reporting cycles between variable defaults (#228)
  remains open. It is not a new finding from this run.
- Passing these checks does not establish coverage of every possible bundle or
  of changes on other unmerged branches.

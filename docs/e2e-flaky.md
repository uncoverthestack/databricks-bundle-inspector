# Known flaky E2E tests

Read this when the E2E workflow is red. A failure listed here, with the same message, is
a known flake: rerun the failed jobs. Any other failure is real until shown otherwise.

To see what failed: `gh run view <run id> --log-failed | grep -A4 "failing"`.

## Flaky tests

| Suite | Test | Where | Message | Status |
| --- | --- | --- | --- | --- |
| graph colours follow the VS Code theme | `<theme>: switched with the graph open` | macOS | `text below WCAG AA`, one theme's text on the previous theme's box colour | Fixed (#665), 26 Nov 2026. Remove this row if it has not failed by 10 Dec. |
| linked issue codes survive repeated checks and quick fixes | applies and clears the include quick fix over five rounds with CRLF | macOS, Linux | `round 1: linked diagnostic should still offer include_matches_nothing` | Open, #666. Seen 6, 25 (twice) and 26 Nov. |
| include mistakes | reads a backslash in an include entry as the CLI does on this platform | Windows | `ENOTEMPTY, Directory not empty` | Fixed by #662 (26 Nov). Remove this row if it has not failed by 10 Dec. |

## Red runs where no test failed

- **"Every group passed" is red, and a group shows as cancelled.** The merge queue
  cancelled the run, usually because an entry ahead of it failed or was removed. Nothing
  failed; the pull request goes back into the queue.
- **Checkout fails with `couldn't find remote ref refs/heads/gh-readonly-queue/...`.** The
  queue removed the entry while the run was starting. Nothing failed.

## Keeping this list

Add a row when a test fails in the merge queue on a pull request that could not have
caused it, and the same commit passes on a rerun. Open an issue for it and link it here.
Remove a row two weeks after its fix if it has not failed again.

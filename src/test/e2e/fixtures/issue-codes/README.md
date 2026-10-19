# Linked issue codes and Quick Fix stress fixture

Run `npm run test:e2e:issue-codes` with the Databricks CLI on `PATH`.
The suite runs in a real VS Code extension host and covers:

- Ten inspections without duplicate CLI warnings; every finding has a linked code.
- Five apply/save/restore rounds for each supported Quick Fix, using Windows (CRLF) line endings.
- Agreement between graph findings and the Problems panel after the repeated edits.
- One hundred findings with the same code; fixing the last one edits only that task and clears exactly one finding.
- Unsaved edits invalidate both Quick Fixes when the YAML value changes, while repeated text in a comment is left alone.
- A 1,000-task job switches between 900 variable-path notes and literal paths over four saves, with linked notes at the correct lines and matching graph findings.

Only the include typo and missing notebook extension are corrected. The two
`bogus_*` fields intentionally remain so CLI warnings can be counted throughout.
The tests restore edited files when they finish. No Databricks login is needed.

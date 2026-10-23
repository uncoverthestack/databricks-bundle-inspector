# variable-mistakes

Fixture for variable mistakes. Each task makes one. `bundle validate -t dev` fails on every one (CLI 1.21.0); the CLI stops at the first it meets, so each message below was checked in a bundle of its own.

| Task | Mistake | CLI, in a target | Inspector, structural preview |
|---|---|---|---|
| `missing_field` | `${var.cluster.nope}`: a field the value doesn't have | `reference does not exist: ${var.cluster.nope}` | `unresolved_variable` |
| `undefined_variable` | `${var.not_defined}` | `reference does not exist: ${var.not_defined}` | `unresolved_variable` |
| `misspelled_variable` | `${var.clustr.node_type_id}` | `reference does not exist` | `unresolved_variable` |
| `required_never_set` | `needs_value` has no default and no target sets it | `no value assigned to required variable needs_value` | NO DEFAULT, no problem: the preview can't know, as a target, a `BUNDLE_VAR_` environment variable or `variable-overrides.json` may set it |
| `cycle` | `loop_a` and `loop_b` default to each other | `cycle detected in field resolution` | not reported yet (#228) |

`validated-bundle.json` is the CLI's structural preview output. Tests: `src/test/unit/extension/variableFixtures.test.ts` and `npm run test:variables:cli`.

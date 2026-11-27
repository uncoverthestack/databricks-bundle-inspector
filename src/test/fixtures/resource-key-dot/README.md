# Resource keys with a dot (issue 511)

A job key, `a.tasks.b`, that would get the same graph ID as task `b` in job `a`, and a pipeline key, `p.q`, set only in target `prod`.

Checked on 2026-11-25:

- CLI v1.28.0 `bundle validate`, in the structural preview and with `-t prod`, accepts both keys. The preview prints `p.q` under `targets.prod.resources`; `-t prod` merges it into `resources`.
- `bundle deploy` of a dotted key, next to a control key that deploys, fails before anything is created. CLI v0.299.2 and v1.17.0 with the Terraform engine: "Invalid resource name". The direct engine crashes ("nil pointer dereference") on v0.299.2, v1.17.0 and v1.28.0, for a job, a pipeline and a schema key. The same bundle with `_` in place of the dot deploys.
- 2026-11-27, CLI v1.28.0, direct engine: adding a dotted key to a bundle deployed before uploads the new files, then crashes. The existing job keeps its old settings, and a run of it returns the new code (#577).

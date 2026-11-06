# Notebook paths

How the inspector applies the Databricks CLI's notebook rules. The CLI stops at the first path error, so each row was checked on its own with `databricks bundle validate`: against a real target on CLI v1.17.0, and on v0.299.2 and v1.24.0 by `npm run test:notebook-rule:cli`, which runs the CLI against a fake workspace on 127.0.0.1 for every job task here. CI runs it on the oldest supported CLI and on the latest, so a CLI release that changes these rules fails it.

From v1.24.0 the CLI counts a `.py`, `.r`, `.scala` or `.sql` file as a notebook when its first line, read from the first 200 bytes, contains `Databricks notebook source`. Before, the line, from the first 32 bytes, had to be exactly the header for the extension. The inspector uses the rule of the CLI that validated the bundle, and the newer rule when the version can't be read.

The newer rule doesn't need a comment: `nb_marker_in_code.py`, whose first line is `print("Databricks notebook source")`, is a notebook. This is the workspace's own import rule (databricks/cli#7290). Checked on 2026-11-06 with `databricks workspace import --format AUTO` (CLI v1.24.0): the workspace stored `nb_marker_in_code.py` and `nb_bom.py` as Python notebooks, and `plain.py` as a file.

| Bundle path | File | CLI before v1.24.0 | CLI v1.24.0 and later |
|---|---|---|---|
| `notebook_task` `../src/nb_noext` | `nb_noext.sql` exists | `notebook "src/nb_noext" not found. Did you mean "src/nb_noext.sql"?` | same |
| `notebook_task` `nb_plain.sql` | no notebook header | `expected a notebook ... but got a file` | same |
| `notebook_task` `nb_ok.sql` | `-- Databricks notebook source` | OK | OK |
| `notebook_task` `nb_crlf.py` | header ending in `\r\n` | OK | OK |
| `notebook_task` `nb_bom.py` | header after a UTF-8 BOM | `expected a notebook ... but got a file` | OK |
| `notebook_task` `nb_trailing_space.py` | header with a trailing space | `expected a notebook ... but got a file` | OK |
| `notebook_task` `nb_extra_text.py` | header with more text after it | `expected a notebook ... but got a file` | OK |
| `notebook_task` `nb_other_comment.py` | `-- Databricks notebook source` in a `.py` file | `expected a notebook ... but got a file` | OK |
| `notebook_task` `nb_marker_in_code.py` | `print("Databricks notebook source")` | `expected a notebook ... but got a file` | OK |
| `notebook_task` `nb_marker_at_190.py` | marker ending at byte 190 of a long first line | `expected a notebook ... but got a file` | OK |
| `notebook_task` `nb_marker_past_200.py` | marker after byte 200 of a long first line | `expected a notebook ... but got a file` | same |
| `notebook_task` `nb_ok.ipynb` | Jupyter, nbformat 4 | OK | OK |
| `notebook_task` `nb_old.ipynb` | Jupyter, nbformat 3 | `unable to determine if ... is a notebook` | same |
| `spark_python_task` `script_nb.py` | has the notebook header | `expected a file ... but got a notebook` | same |
| `spark_python_task` `nb_bom.py` | header after a UTF-8 BOM | OK | `expected a file ... but got a notebook` |
| `sql_task.file` `query_nb.sql` | has the notebook header | `expected a file ... but got a notebook` | same |
| `spark_python_task` `plain.py` | plain Python | OK | OK |
| pipeline `notebook` `../src/nb_noext` | `nb_noext.sql` exists | `notebook "src/nb_noext" not found. Did you mean ...?` | same |
| pipeline `notebook` `nb_plain.sql` | no notebook header | `expected a notebook ... but got a file` | same |
| pipeline `file` `script_nb.py` | has the notebook header | `expected a file ... but got a notebook` | same |
| pipeline `notebook` `nb_ok.sql` | `-- Databricks notebook source` | OK | OK |
| `git_sourced` job `notebook_task` `nb_plain.sql` | job has `git_source` | OK: the CLI does not check paths in a job with a `git_source` | same |

The inspector reports each error above as a hint ("may not be a notebook", "may be a notebook, not a file"). For a file the exact rule turns down but the newer rule takes, the hint says why and that a newer CLI takes it.

Pipeline rows were checked on v1.17.0 only; the test runs job tasks.

`src/**` is marked `-text` in `.gitattributes` so the CRLF and BOM bytes are not normalised on checkout.

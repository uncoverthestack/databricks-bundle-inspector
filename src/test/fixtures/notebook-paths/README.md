# Notebook paths

How the inspector applies the Databricks CLI's notebook rules. Each row was checked on its own with `databricks bundle validate` against a real target (CLI v1.17.0), because the CLI stops at the first path error.

| Bundle path | File | CLI | Inspector |
|---|---|---|---|
| `notebook_task` `../src/nb_noext` | `nb_noext.sql` exists | `notebook "src/nb_noext" not found. Did you mean "src/nb_noext.sql"?` | Notebook may not be found. Did you mean `nb_noext.sql`? |
| `notebook_task` `nb_plain.sql` | no notebook header | `expected a notebook ... but got a file` | May not be a notebook |
| `notebook_task` `nb_ok.sql` | `-- Databricks notebook source` | OK | No issue |
| `notebook_task` `nb_crlf.py` | header ending in `\r\n` | OK | No issue |
| `notebook_task` `nb_bom.py` | header after a UTF-8 BOM | `expected a notebook ... but got a file` | May not be a notebook |
| `notebook_task` `nb_trailing_space.py` | header with a trailing space | `expected a notebook ... but got a file` | May not be a notebook |
| `notebook_task` `nb_ok.ipynb` | Jupyter, nbformat 4 | OK | No issue |
| `notebook_task` `nb_old.ipynb` | Jupyter, nbformat 3 | `unable to determine if ... is a notebook` | May not be a notebook |
| `spark_python_task` `script_nb.py` | has the notebook header | `expected a file ... but got a notebook` | May be a notebook, not a file |
| `sql_task.file` `query_nb.sql` | has the notebook header | `expected a file ... but got a notebook` | May be a notebook, not a file |
| `spark_python_task` `plain.py` | plain Python | OK | No issue |
| pipeline `notebook` `../src/nb_noext` | `nb_noext.sql` exists | `notebook "src/nb_noext" not found. Did you mean ...?` | Notebook may not be found. Did you mean `nb_noext.sql`? |
| pipeline `notebook` `nb_plain.sql` | no notebook header | `expected a notebook ... but got a file` | May not be a notebook |
| pipeline `file` `script_nb.py` | has the notebook header | `expected a file ... but got a notebook` | May be a notebook, not a file |
| pipeline `notebook` `nb_ok.sql` | `-- Databricks notebook source` | OK | No issue |
| `git_sourced` job `notebook_task` `nb_plain.sql` | job has `git_source` | OK: the CLI does not check paths in a job with a `git_source` | No issue |

`src/**` is marked `-text` in `.gitattributes` so the CRLF and BOM bytes are not normalised on checkout.

# What the inspector checks

[Back to the README](../README.md)

These are the problems the inspector reports. Each one is listed in the Problems panel at the file and line it comes from, and in the graph's issues list.

Two of them come with a fix you can apply from the light bulb, or the Quick Fix menu (`Cmd+.` on macOS, `Ctrl+.` on Windows and Linux): a notebook path without its extension (`src/etl` becomes `src/etl.py`), and an `include` pattern with a likely typo (`resource/*.yml` becomes `resources/*.yml`). The fix is only offered while the file still holds the value the check read, so a path that comes from a variable or a target override gets no fix.

- **Missing local files**: notebooks and files referenced by tasks that don't exist, including the inner task of a `for_each` task.
- **Missing libraries**: local wheels and JARs a task installs that aren't there.
- **Pipeline sources**: Lakeflow Spark Declarative Pipelines (formerly Delta Live Tables, DLT) whose `libraries` point at a missing notebook or file, or at a `folder/**` glob with no files. The CLI doesn't check these during validation, so they otherwise surface only on `bundle deploy`.
- **Notebook and file mix-ups**: a notebook path without its extension, a notebook task pointing at a file without the notebook header, or a Python or SQL file task pointing at a notebook, following the Databricks CLI's rules.
- **Files that won't be deployed**: a task or pipeline pointing at a file that `.gitignore` or `sync.exclude` keeps out of `bundle deploy`.
- **`include` mistakes**: an `include` pattern that matches no files because of a likely typo (a misspelled folder, or `.yml` where the files end in `.yaml`), and a YAML file that defines resources but isn't in the include list. The CLI loads only what `include` selects and says nothing about the rest, so the bundle just has fewer jobs than you expect.
- **Widget parameters**: a notebook reading a widget that neither the task nor the job passes and that has no default, including through `%run` and across Python and SQL cells.
- **Task values**: `dbutils.jobs.taskValues.get(...)` or `{{tasks.<task>.values.<key>}}` reading from a task that doesn't exist, isn't upstream, or doesn't set that key.
- **Secret scope mix-ups**: code that reads a secret using the scope's resource key instead of its name, which fails at runtime.
- **Unresolved variables**: `${var.*}` values with no default and no value for the selected target.
- **Databricks CLI diagnostics**: validation errors and warnings, including unknown or deprecated fields, sent to the Problems panel.
- **Risky patterns**: task types the inspector doesn't recognise, and tasks that load code from Git when the job has no `git_source`.

## Code it reads

Checks on code (secrets, widgets, task values) read **Python and SQL**:

- `.py` and `.sql` files, Jupyter notebooks (`.ipynb`), and Databricks source-format notebooks.
- `%python` and `%sql` cells inside a notebook of the other language, each read in its own language.
- `dbutils` wherever it can be traced: `dbutils` itself (also as `self.dbutils`), a variable assigned from it, `DBUtils(spark)` or `get_dbutils(spark)`, imports under another name, and the Databricks SDK (`WorkspaceClient().dbutils`, `w.secrets.get_secret(...)`). A call on something that can't be traced, such as a function parameter named `d`, isn't counted; a widget read there makes the inspector say it couldn't check that notebook.

**Scala and R are not read.** `.scala` and `.r` notebooks, and `%scala` and `%r` cells, are skipped, so secrets, widgets and task values in them are not found. Markdown cells and other magic cells (`%md`, `%sh`, `%pip`) are not code and are skipped too.

Added

- **A file in a pipeline glob's folder that fails the pipeline update is now an error** ([#531](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/531)). Deploy uploads every file under `include: ../src/dlt/**`, hidden ones too, and the update fails on any type but `.py` and `.sql`, apart from a few it skips (`.md`, `.txt`, `.csv`, `.json`, `.ipynb`): a `.gitkeep`, a `.DS_Store`, a `config.yml` or a `Makefile` is enough. `bundle validate` and deploy pass. The finding names the file to add to `sync.exclude`.

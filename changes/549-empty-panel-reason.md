Fixed

- **An empty panel says why jobs may be missing** ([#549](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/549)). In structural preview, a bundle whose jobs are defined in Python (the `python` section) or set only inside a target used to say it defines no jobs or pipelines. It now says "Jobs defined in Python may be missing: the inspector doesn't run bundle code." or "Jobs set inside the dev and prod targets may be missing until you pick one.", naming the targets that hold them.

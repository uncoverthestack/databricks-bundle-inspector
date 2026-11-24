Fixed

- **The inspection finishes when a notebook or file path points at a named pipe** ([#508](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/508)). A task or pipeline path to a named pipe (made with `mkfifo`) passes `bundle validate`, and the inspector then waited forever for its contents. It now reads only regular files.

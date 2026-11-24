Fixed

- **The inspection copes with two unusual bundle shapes found by stress testing** ([#508](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/508), [#509](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/509)). A task or pipeline path that points at a named pipe no longer leaves the inspection waiting, and a chain of thousands of variables that each refer to the next no longer stops it. Neither shape is expected in a real bundle.

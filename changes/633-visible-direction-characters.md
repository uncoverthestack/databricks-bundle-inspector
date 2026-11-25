Fixed

- **Hidden text-direction characters are shown in findings and reports** ([#633](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/633)). A name from the bundle holding Unicode direction overrides or isolates (U+202A to U+202E, U+2066 to U+2069) could be shown as another name: a missing `./src/` + U+202E + `yp.tset` read as `./src/test.py`. Findings, copied reviews and the command line's reports now show each one as a marker such as `[U+202E]`. Names on the graph's boxes are not changed yet.

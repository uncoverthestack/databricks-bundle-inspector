# saved-file fixture

Opened as a folder by `npm run test:e2e:saved-file`. The test never runs Inspect and never saves `databricks.yml`.

`src/consumer.py` reads the task value `rowcount`. `src/producer.py` sets `row_count`, so the inspector warns. The test fixes and breaks `consumer.py` again, from the editor and from outside it, and expects the warning to follow each time.

`npm run test:e2e:saved-file:other-case` opens the same folder under another letter case (`SAVED-FILE`), which only works where the file system ignores case.

# saved-file fixture

Opened as a folder by `npm run test:e2e:saved-file`. The test never runs Inspect and never saves `databricks.yml`.

`src/consumer.py` reads the task value `rowcount`. `src/producer.py` sets `row_count`, so the inspector warns. The test fixes and breaks `consumer.py` again, from the editor and from outside it, and expects the warning to follow each time.

`npm run test:e2e:saved-file:other-case` opens the same folder under another letter case (`SAVED-FILE`), which only works where the file system ignores case.

`src/runner.py` runs `src/helpers/child.py` with `%run`, and the child reads the widget `child_setting`, which nothing sets. The test fixes and breaks only the child, so the warning must follow a file the bundle never names (#451). It also creates `src/orphan.py` and `src/orphan.sql`, two notebooks no task names that deploy to the same workspace path, and deletes them again.

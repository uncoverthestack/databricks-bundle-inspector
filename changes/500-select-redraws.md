Fixed

- **Selecting a task in a large job no longer redraws every task box** ([#500](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/500)). A click redrew every box in the job three times. It now redraws only the boxes that change. In a 1,000-task job, selecting a task took about 290 ms and now takes about 70 ms; at 300 tasks, about 85 ms became 40 ms. Jobs with a few dozen tasks feel the same as before.

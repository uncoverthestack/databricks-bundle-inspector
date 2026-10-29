Fixed

- **Telemetry sent after a wait no longer loses whole batches** ([#322](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/322)). Events waiting to be sent went 50 at a time, and 50 large events could pass the telemetry proxy's size limit, which refused the request and dropped all 50. Batches now go by size as well as count, at most 32 KB each, so every event is sent whole, in order, in as many requests as it takes.

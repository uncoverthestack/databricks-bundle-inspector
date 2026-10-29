Changed

- **Telemetry is checked against its published list before it leaves your machine** ([#320](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/320)). The extension now drops any event or property not listed in [telemetry.json](telemetry.json), or a value outside what it allows, before sending, using the same check the telemetry proxy applies. Until now only the proxy did. What reaches PostHog is unchanged.

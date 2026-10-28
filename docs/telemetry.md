# Telemetry

[Back to the README](../README.md)

The extension collects usage data to learn which features are used and where people get stuck. A notice tells you about it the first time the extension starts with telemetry on. Nothing is sent until you have closed or answered that notice, and nothing from that VS Code window: events wait on your machine and are sent from the next time VS Code is opened, so you have time to turn it off. If the notice never reaches you (for example with Do Not Disturb on), it is shown again next time and nothing is sent.

**To turn it off**, use either setting:

- `databricksBundleInspector.telemetry.enabled`: set to `false` to turn off telemetry for this extension only.
- `telemetry.telemetryLevel`: anything other than `all` turns off usage data for VS Code and every extension that respects it, including this one.

Turning it off also deletes any events still waiting to be sent and what is kept for the daily summary below, and stops the uninstall event.

- **Collected:** that the extension started in a VS Code window, with how many bundles the open folders hold as a range (for example "2-5"), whether one sits at the top of the folder, whether the Databricks CLI could be run, and how many problems the first check found as a range (never which ones). Also which features are used (inspecting a bundle, switching jobs or targets, opening files from the graph, whether the graph was opened from a resource file rather than `databricks.yml` (never which file), copying the review summary, applying a suggested fix and which kind of finding it fixed, never the paths or values), how an inspection turned out (for example "Databricks CLI not found"), why a picked target couldn't be checked as one fixed word (for example `login_expired`, never the message), why the Databricks CLI couldn't be used, its major and minor version (for example `1.21`) and whether it is older than the oldest tested version, whether the sign-in terminal was opened for a target and whether the Databricks CLI then saved that profile (never the profile, host or account), which rows and buttons of the sidebar are used, each at most once per window (for example "open graph" or "check again", never which bundle or target or how often) and whether the sidebar was showing, coarse bundle size ranges (for example "6-20 tasks"), which Databricks task types appear (for example `notebook_task`), and a one-time event when the extension is uninstalled.
- **Daily summary of findings resolved:** once a day, for the previous day the extension checked bundles, whether findings were resolved, and how many findings were resolved and how many were new, as ranges (for example "2-5"). Every bundle is added into one event, so it never says which bundle, how many bundles, or which findings. The comparison is made on your machine, between the automatic checks of the same bundle on the same branch, extension version and Databricks CLI version. A finding that went away with its job, task or file is not counted as resolved, and a day whose checks failed or could not be compared says so instead of reporting zero.
- **Kept on your machine, never sent:** for that summary, each bundle's errors and warnings from its last check, its branch and the versions, all as one-way hashes salted with a random value created on your machine, in VS Code's storage for this extension. Bundles not checked for 90 days are dropped, and at most 20 are kept.
- **Environment:** extension and VS Code version, OS, OS version and CPU type (for example `darwin`, `25.0.0`, `arm64`), and remote type (for example WSL or SSH).
- **Never collected:** file paths or contents, bundle, job, task or target names, workspace hosts, search text, or error messages.
- **Identity:** a pseudonymous per-install ID, a one-way hash of VS Code's machine ID (never the ID itself). It names no one, but it links the events of one install. No VS Code session ID, no accounts, no IP address, no location.
- **Offline:** events wait on your machine (up to 500, for at most 14 days) and are sent when you are back online.
- **Where it goes:** events are sent to a small proxy run by this project ([telemetry-proxy/](../telemetry-proxy)). The proxy drops anything not listed in `telemetry.json` and forwards the rest to PostHog. The extension itself contains no analytics keys.

Every event and property is listed in [telemetry.json](../telemetry.json). To see events as they are sent, run **Developer: Set Log Level…** → **Trace**, then open the **Output** panel and pick the extension's telemetry channel.

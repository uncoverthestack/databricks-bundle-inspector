# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately with GitHub's **Report a vulnerability** button on the
[Security tab](https://github.com/uncoverthestack/databricks-bundle-inspector/security/advisories/new).
Include what you found, how to reproduce it, and which version you used.

You can expect a first reply within a few days. Once a fix is released, the report is
credited unless you prefer to stay anonymous.

## Supported versions

Only the latest release on the VS Code Marketplace and Open VSX receives fixes.

## What the extension does and does not do

- It reads the files in the folder you open and runs one external program, the Databricks CLI
  you installed (`databricks bundle validate`), with fixed arguments.
- It does not run code from your bundle, such as notebooks or build commands.
- Usage telemetry never includes paths, names or file contents, and can be turned off.
  See the [README](README.md#telemetry).

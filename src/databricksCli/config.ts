import * as vscode from "vscode";

/**
 * Gets the VS Code workspace configuration section for the `databricksBundleInspector` extension
 *
 * @returns The `databricksBundleInspector` from the VS Code workspace configuration
 */
export function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("databricksBundleInspector");
}

/**
 * Gets the user-configured Databricks CLI path from extension settings.
 *
 * @param config The workspace configuration section for the extension.
 * @returns The configured CLI path, or `undefined` if not set.
 */
export function getConfiguredDatabricksCliPath(
  config: vscode.WorkspaceConfiguration,
): string | undefined {
  return config.get<string>("cliPath");
}

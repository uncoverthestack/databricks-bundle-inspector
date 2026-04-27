import path from "node:path";

interface EditorWithFileName {
  document?: {
    fileName?: string;
  };
}

/**
 * Checks whether the given file name is a Databricks bundle configuration file.
 *
 * The main bundle configuration file is typically named `databricks.yml`.
 * `databricks.yaml` is also accepted.
 *
 * @param fileName The file name to check.
 * @returns `true` if the file name is `databricks.yml` or `databricks.yaml`; otherwise `false`.
 */
export function isBundleFile(fileName: string): boolean {
  return fileName === "databricks.yaml" || fileName === "databricks.yml";
}

/**
 * Returns the directory that contains the Databricks bundle configuration file
 * currently open in the given editor.
 *
 * @param editor The active VS Code text editor, if any.
 * @returns The absolute path of the bundle root directory, or `undefined` if
 *   the editor has no active file or the file is not a Databricks bundle
 *   configuration file.
 */
export function getBundleDirFromEditor(
  editor?: EditorWithFileName,
): string | undefined {
  const filePath = editor?.document?.fileName;

  if (!filePath || !isBundleFile(path.basename(filePath))) {
    return undefined;
  }

  return path.dirname(filePath);
}

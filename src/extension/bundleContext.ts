import path from "node:path";

interface EditorLike {
  document?: {
    fileName?: string;
  };
}

export function isBundleFile(fileName: string): boolean {
  return fileName === "databricks.yaml" || fileName === "databricks.yml";
}

export function getBundleDirFromEditor(
  editor?: EditorLike,
): string | undefined {
  const filePath = editor?.document?.fileName;

  if (!filePath || !isBundleFile(path.basename(filePath))) {
    return undefined;
  }

  return path.dirname(filePath);
}

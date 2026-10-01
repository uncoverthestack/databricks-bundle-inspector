import path from "path";
import { isBundleFile } from "../bundle/bundleContext.js";

export function isBundlePath(filePath: string): boolean {
  return isBundleFile(path.basename(filePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedDirectoryPath = path.resolve(directoryPath);
  const relativePath = path.relative(resolvedDirectoryPath, resolvedFilePath);

  return (
    relativePath === "" ||
    (relativePath.length > 0 &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  );
}

export function isOpenFilePathAllowed(
  filePath: string,
  activeBundleDir: string | undefined,
  workspaceFolders:
    | readonly { uri: { fsPath: string } }[]
    | undefined,
): boolean {
  if (!filePath || !path.isAbsolute(filePath)) return false;

  if (activeBundleDir && isPathInDirectory(filePath, activeBundleDir)) {
    return true;
  }

  return (workspaceFolders ?? []).some((folder) =>
    isPathInDirectory(filePath, folder.uri.fsPath),
  );
}

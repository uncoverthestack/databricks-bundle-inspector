import { realpathSync } from "node:fs";
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

/** The path with every symlink followed, or undefined when there is nothing there. */
function realPath(filePath: string): string | undefined {
  try {
    return realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Whether the graph may open this file: inside the active bundle or an open workspace
 * folder, both as written and, for a file that exists, where it really leads. A symlink
 * inside the workspace can point anywhere (#326); one pointing inside it still opens. The
 * folders are compared by their real locations too (macOS's /var is /private/var). A path
 * that doesn't exist has nothing to follow, and VS Code says so when it opens.
 */
export function isOpenFilePathAllowed(
  filePath: string,
  activeBundleDir: string | undefined,
  workspaceFolders:
    | readonly { uri: { fsPath: string } }[]
    | undefined,
): boolean {
  if (!filePath || !path.isAbsolute(filePath)) return false;

  const roots = [
    ...(activeBundleDir ? [activeBundleDir] : []),
    ...(workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  ];
  if (!roots.some((root) => isPathInDirectory(filePath, root))) return false;

  const real = realPath(filePath);
  if (real === undefined) return true;
  return roots.some((root) => isPathInDirectory(real, realPath(root) ?? root));
}

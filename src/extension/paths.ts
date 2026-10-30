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
 * folder. For a file that exists, by where it really leads, every link followed, against
 * the folders' real locations: a symlink or junction inside the workspace can point
 * anywhere (#326), one pointing inside it still opens, and the forms a path can take
 * (macOS's /var for /private/var, Windows' 8.3 short names) don't matter (#330). A path that
 * doesn't exist has nothing to follow, so it is decided as written, and VS Code says so
 * when it opens.
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
  const real = realPath(filePath);
  if (real === undefined) return roots.some((root) => isPathInDirectory(filePath, root));
  return roots.some((root) => isPathInDirectory(real, realPath(root) ?? root));
}

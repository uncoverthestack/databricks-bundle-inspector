/**
 * What the inspector knows about a file a task points at, from the graph alone: not checked
 * (its path uses a variable), in the workspace or cloud storage, missing, found, or unknown.
 * Shared by the panel and the command-line tool (#348, #392).
 */

export type FileStatusKey = "template" | "remote" | "missing" | "found" | "unknown";

export interface FileStatusReference {
  path?: string | undefined;
  resolvedPath?: string | undefined;
  exists?: boolean | undefined;
}

/** A path in the workspace, DBFS or cloud storage, which the inspector can't look at offline. */
export function isRemotePath(path: string | undefined): boolean {
  return Boolean(
    path?.startsWith("/Workspace/") ||
      path?.startsWith("dbfs:/") ||
      path?.startsWith("s3://") ||
      path?.startsWith("abfss://") ||
      path?.startsWith("gs://"),
  );
}

/** A path that still has `${...}` or `{{...}}` in it, so the file is only known once a target is resolved. */
export function hasTemplate(path: unknown): boolean {
  return typeof path === "string" && (path.includes("${") || path.includes("{{"));
}

export function fileStatusKey(ref: FileStatusReference): FileStatusKey {
  if (hasTemplate(ref.path)) return "template";
  if (isRemotePath(ref.path)) return "remote";
  if (ref.resolvedPath && !ref.exists) return "missing";
  if (ref.exists) return "found";
  return "unknown";
}

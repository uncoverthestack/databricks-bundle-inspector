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

/**
 * A path in the workspace (with or without the `/Workspace` prefix), a volume, DBFS or cloud
 * storage, which never exists locally. The one rule the graph, the panel and the export use.
 */
export function isRemotePath(path: string | undefined): boolean {
  return Boolean(
    path?.startsWith("/Workspace/") ||
      path?.startsWith("/Users/") ||
      path?.startsWith("/Shared/") ||
      path?.startsWith("/Repos/") ||
      path?.startsWith("/Volumes/") ||
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

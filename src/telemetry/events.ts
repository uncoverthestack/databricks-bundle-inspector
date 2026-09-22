import path from "path";
import { validateProperties, type TelemetryProperties } from "./schema.js";

/** Events the webview may report. Anything else sent over the bridge is ignored. */
export const WEBVIEW_EVENTS: readonly string[] = [
  "graph_mode_changed",
  "job_selected",
  "search_result_selected",
  "issue_item_selected",
];

const SAFE_STRING = /^[a-z0-9_.-]{1,40}$/i;

export function parseWebviewTelemetryMessage(
  message: unknown,
): { event: string; properties: TelemetryProperties } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { event, properties } = message as { event?: unknown; properties?: unknown };
  if (typeof event !== "string" || !WEBVIEW_EVENTS.includes(event)) return undefined;
  return { event, properties: validateProperties(event, properties) };
}

/** Coarse size buckets so bundle shapes can't fingerprint a specific project. */
export function countBucket(count: number): string {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 20) return "6-20";
  if (count <= 50) return "21-50";
  return "51+";
}

const KNOWN_FILE_KINDS = new Set(["py", "ipynb", "sql", "yml", "yaml", "json", "whl", "jar", "scala", "r"]);

export function fileKind(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === "yaml") return "yml";
  return KNOWN_FILE_KINDS.has(ext) ? ext : "other";
}

/**
 * Distinct task types as Databricks' own `*_task` keys (e.g. notebook_task,
 * for_each_task), sorted and comma-joined. Never includes task names or values.
 */
export function taskKinds(
  nodes: readonly { nodeType: string; data: Record<string, unknown> }[],
): string {
  const kinds = new Set<string>();
  for (const node of nodes) {
    if (node.nodeType !== "task") continue;
    for (const key of Object.keys(node.data)) {
      if (key.endsWith("_task") && SAFE_STRING.test(key)) kinds.add(key);
    }
  }
  return [...kinds].sort().join(",");
}

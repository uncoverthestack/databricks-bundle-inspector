/**
 * The single definition of every telemetry event and the values its properties
 * may take. Used by the extension (webview allowlist) and by the proxy in
 * telemetry-proxy/, which drops anything that does not match. Keep
 * telemetry.json in sync; a unit test enforces it.
 */
export type TelemetryProperties = Record<string, string | number | boolean>;

export interface WireEvent {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: TelemetryProperties;
}

type Rule =
  | { type: "enum"; values: readonly string[] }
  | { type: "boolean" }
  | { type: "integer"; max: number }
  | { type: "pattern"; pattern: RegExp };

const oneOf = (...values: string[]): Rule => ({ type: "enum", values });
const bool: Rule = { type: "boolean" };
const bucket = oneOf("0", "1", "2-5", "6-20", "21-50", "51+");

export const EVENT_SCHEMA: Record<string, Record<string, Rule>> = {
  inspect_bundle: {
    trigger: oneOf("command", "issues_command", "target_switch"),
    outcome: oneOf(
      "ok",
      "ok_with_errors",
      "no_bundle_file",
      "cli_not_found",
      "cli_not_executable",
      "validation_timeout",
      "invalid_bundle_shape",
      "validation_failed",
      "exception",
    ),
    duration_ms: { type: "integer", max: 3_600_000 },
    has_diagnostics: bool,
    target_mode: oneOf("target", "probe"),
    fell_back_to_probe: bool,
    auth_configured: bool,
    target_count: bucket,
    job_count: bucket,
    task_count: bucket,
    task_kinds: { type: "pattern", pattern: /^([a-z_]{1,40}_task(,[a-z_]{1,40}_task){0,30})?$/ },
    issue_count: bucket,
  },
  bundle_refreshed_on_save: { bundle_file: bool },
  file_opened: {
    file_kind: oneOf("py", "ipynb", "sql", "yml", "json", "whl", "jar", "scala", "r", "other"),
  },
  review_summary_copied: {},
  graph_mode_changed: { mode: oneOf("all", "issues") },
  job_selected: {},
  search_result_selected: {},
  issue_item_selected: {},
  extension_uninstalled: {},
};

/** VS Code's TelemetryLogger common properties, e.g. common.extversion. */
const COMMON_KEY = /^common\.[a-z]{1,40}$/;
const COMMON_VALUE = /^[\w .:+()/@-]{0,100}$/;
const DISTINCT_ID = /^[0-9a-f]{32}$/;
const MAX_PAST_MS = 15 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

function matchesRule(value: unknown, rule: Rule): value is string | number | boolean {
  switch (rule.type) {
    case "enum":
      return typeof value === "string" && rule.values.includes(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= rule.max;
    case "pattern":
      return typeof value === "string" && rule.pattern.test(value);
  }
}

export function isKnownEvent(event: unknown): event is string {
  return typeof event === "string" && Object.hasOwn(EVENT_SCHEMA, event);
}

/** Keeps only the event's declared properties with valid values (plus common.* when allowed). */
export function validateProperties(
  event: string,
  raw: unknown,
  options: { allowCommon?: boolean } = {},
): TelemetryProperties {
  const rules = EVENT_SCHEMA[event] ?? {};
  const properties: TelemetryProperties = {};
  if (typeof raw !== "object" || raw === null) return properties;
  for (const [key, value] of Object.entries(raw)) {
    const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
    if (rule) {
      if (matchesRule(value, rule)) properties[key] = value;
    } else if (
      options.allowCommon &&
      COMMON_KEY.test(key) &&
      !key.includes("machineid") &&
      (typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && COMMON_VALUE.test(value)))
    ) {
      properties[key] = value;
    }
  }
  return properties;
}

/** Returns a clean copy of an incoming event, or undefined if it must be dropped. */
export function validateWireEvent(raw: unknown, now: number): WireEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { event, distinct_id, timestamp, properties } = raw as Record<string, unknown>;
  if (!isKnownEvent(event)) return undefined;
  if (typeof distinct_id !== "string" || !DISTINCT_ID.test(distinct_id)) return undefined;
  if (typeof timestamp !== "string") return undefined;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time) || time < now - MAX_PAST_MS || time > now + MAX_FUTURE_MS) return undefined;
  return {
    event,
    distinct_id,
    timestamp: new Date(time).toISOString(),
    properties: validateProperties(event, properties, { allowCommon: true }),
  };
}

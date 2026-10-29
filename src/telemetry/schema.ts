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
  // `maxLength` states the longest value the pattern allows, so the largest possible event
  // can be worked out from the schema (telemetry.test.ts keeps it under the batch budget).
  | { type: "pattern"; pattern: RegExp; maxLength: number };

const oneOf = (...values: string[]): Rule => ({ type: "enum", values });
const bool: Rule = { type: "boolean" };
const bucket = oneOf("0", "1", "2-5", "6-20", "21-50", "51+");
/** `major.minor` only, e.g. `1.21` (see telemetryCliVersion). */
const cliVersion: Rule = { type: "pattern", pattern: /^\d{1,3}\.\d{1,4}$/, maxLength: 8 };

/** The findings whose quick fix is counted, by kind. */
export const QUICK_FIX_KINDS: readonly string[] = [
  "notebook_missing_extension",
  "include_matches_nothing",
  "missing_file",
  "missing_pipeline_source",
];

/** What was used in the sidebar. Only rows and buttons of the sidebar, never the Command Palette. */
export const SIDEBAR_ACTIONS = [
  "open_graph",
  "open_problems",
  "pick_problem",
  "open_target",
  "open_bundle_file",
  "check_again",
  "check_all",
  "choose_cli",
  "choose_profile",
  "open_sign_in_terminal",
] as const;
export type SidebarAction = (typeof SIDEBAR_ACTIONS)[number];

export const EVENT_SCHEMA: Record<string, Record<string, Rule>> = {
  extension_activated: {
    bundle_count: bucket,
    bundle_at_root: bool,
    cli_found: bool,
    cli_version: cliVersion,
    issue_count: bucket,
  },
  inspect_bundle: {
    trigger: oneOf("command", "issues_command", "target_switch", "status_bar", "sidebar", "sign_in_retry"),
    from_resource_file: bool,
    outcome: oneOf(
      "ok",
      "ok_with_errors",
      "no_bundle_file",
      "cli_not_found",
      "cli_not_executable",
      "validation_timeout",
      "validation_output_too_large",
      "invalid_bundle_shape",
      "validation_failed",
      "exception",
    ),
    cli_problem: oneOf("not_installed", "configured_path_invalid", "not_databricks_cli"),
    cli_outdated: bool,
    cli_version: cliVersion,
    duration_ms: { type: "integer", max: 3_600_000 },
    has_diagnostics: bool,
    target_mode: oneOf("target", "probe"),
    fell_back_to_probe: bool,
    fallback_reason: oneOf(
      "timeout",
      "not_logged_in",
      "no_profile",
      "several_profiles",
      "other_workspace",
      "no_such_target",
      "login_unreachable",
      "login_expired",
      "login_other",
      "other",
    ),
    auth_configured: bool,
    target_count: bucket,
    job_count: bucket,
    pipeline_count: bucket,
    task_count: bucket,
    task_kinds: { type: "pattern", pattern: /^([a-z_]{1,40}_task(,[a-z_]{1,40}_task){0,30})?$/, maxLength: 31 * 45 + 30 },
    issue_count: bucket,
  },
  bundle_refreshed_on_save: { bundle_file: bool },
  file_opened: {
    file_kind: oneOf("py", "ipynb", "sql", "yml", "json", "whl", "jar", "scala", "r", "other"),
  },
  review_summary_copied: { format: oneOf("summary", "report") },
  graph_mode_changed: { mode: oneOf("all", "issues") },
  job_selected: {},
  pipeline_selected: {},
  search_result_selected: {},
  issue_item_selected: {},
  quick_fix_applied: { kind: oneOf(...QUICK_FIX_KINDS) },
  sidebar_opened: { at_start: bool },
  sign_in: { step: oneOf("terminal_opened", "profile_updated"), from: oneOf("graph", "sidebar") },
  sidebar_action: { action: oneOf(...SIDEBAR_ACTIONS) },
  bundle_progress: {
    comparison: oneOf("compared", "not_comparable", "check_incomplete"),
    resolved: bucket,
    new: bucket,
  },
  extension_uninstalled: {},
};

/**
 * Common properties we keep: VS Code's TelemetryLogger ones plus those telemetry.ts adds.
 * An allowlist, not a pattern, so device IDs such as common.sqmid (Windows) never pass.
 */
export const COMMON_KEYS: ReadonlySet<string> = new Set([
  "common.appname",
  "common.arch",
  "common.extname",
  "common.extversion",
  "common.isnewappinstall",
  "common.os",
  "common.platformversion",
  "common.product",
  "common.remotename",
  "common.uikind",
  "common.vscodecommithash",
  "common.vscodereleasedate",
  "common.vscodeversion",
]);
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
      return typeof value === "string" && value.length <= rule.maxLength && rule.pattern.test(value);
  }
}

export function isKnownEvent(event: unknown): event is string {
  return typeof event === "string" && Object.hasOwn(EVENT_SCHEMA, event);
}

/**
 * What the extension sends for an event: the same check the proxy applies, so a property
 * or value the schema doesn't allow never leaves this machine (#320). Only the event's
 * declared properties with valid values, plus the common.* keys in {@link COMMON_KEYS},
 * so machine and device IDs never leave either. Undefined for an event the schema doesn't
 * know, which isn't sent at all. The proxy still checks everything it receives.
 */
export function outgoingProperties(
  event: string,
  data: Record<string, unknown> | undefined,
): TelemetryProperties | undefined {
  if (!isKnownEvent(event)) return undefined;
  return validateProperties(event, data ?? {}, { allowCommon: true });
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
      COMMON_KEYS.has(key) &&
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

import { describeCronExpression } from "./graph/cronDescription.js";

/**
 * What starts a job, in words (issue 733). `short` is the few words on the overview box: never a
 * table name, a path or a raw cron. `full` and `detail` are for the job's details.
 */
export interface JobTriggerWords {
  /** "Schedule" for `schedule`, else "Trigger". */
  label: "Schedule" | "Trigger" | "Sync";
  short: string;
  full: string;
  /** The raw cron, or the tables, when they add to `full`. */
  detail?: string[];
  /** A job's SQL condition in words (issue 737): what must be true before the run goes ahead. */
  condition?: string[];
}

interface JobTriggerFields {
  schedule?: { quartz_cron_expression?: unknown; timezone_id?: unknown; pause_status?: unknown; sql_condition?: unknown };
  continuous?: unknown;
  trigger?: {
    file_arrival?: { url?: unknown };
    table_update?: { table_names?: unknown };
    table?: { table_names?: unknown };
    periodic?: { interval?: unknown; unit?: unknown };
    pause_status?: unknown;
    sql_condition?: unknown;
  };
}

/** Longer than this, a schedule's words leave the box and it says "Scheduled". */
const SHORT_MAX = 32;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const paused = (value: unknown) => typeof value === "string" && value.toUpperCase() === "PAUSED";

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && name.trim() !== "") : [];
}

function withPause(words: Omit<JobTriggerWords, "short" | "full"> & { short: string; full: string }, isPaused: boolean): JobTriggerWords {
  return isPaused ? { ...words, short: `${words.short} · Paused`, full: `${words.full} (paused)` } : words;
}

/**
 * A Quartz schedule in words, for a job, an alert or a monitor (issues 733, 541). Too long for the
 * box, it keeps its first part ("Every hour" of "Every hour at 19 minutes 44 seconds past"); the
 * details keep it all.
 */
export function scheduleWords(cron: string, timezone: string | undefined, isPaused: boolean): JobTriggerWords {
  const words = describeCronExpression(cron);
  const described = words !== cron;
  const plain = described ? words.replace(/^Runs e/, "E") : "";
  const head = plain.split(/ at |, /)[0] ?? "";
  const short = !described ? "Scheduled" : plain.length <= SHORT_MAX ? plain : head.startsWith("Every") && head.length <= SHORT_MAX ? head : "Scheduled";
  return withPause(
    {
      label: "Schedule",
      short,
      full: described ? `${plain}${timezone ? ` (${timezone})` : ""}` : `Cron schedule${timezone ? ` (${timezone})` : ""}`,
      detail: [cron],
    },
    isPaused,
  );
}

/**
 * A schedule's or a trigger's `sql_condition` (beta, issue 737) in words: after the cron or trigger
 * fires, a saved query decides if the run goes ahead. Undefined when none is set.
 */
function conditionWords(value: unknown): string[] | undefined {
  if (!isObject(value)) return undefined;
  const query = text(value.sql_query_id);
  const changes = text(value.trigger_mode)?.toUpperCase() === "RESULT_VALUE_CHANGES";
  const when = !query
    ? "Runs only when its SQL condition is met"
    : changes
      ? `Runs only when query ${query}'s value changes`
      : `Runs only when query ${query} returns rows`;
  const warehouse = text(value.warehouse_id);
  return [when, ...(warehouse ? [`On warehouse ${warehouse}`] : [])];
}

/** The job's schedule or trigger in words, with its SQL condition, or undefined when it sets none. */
export function jobTriggerWords(job: JobTriggerFields): JobTriggerWords | undefined {
  const words = triggerWords(job);
  if (!words) return undefined;
  // The condition of the field the words came from: the schedule wins, as in triggerWords.
  const source = words.label === "Schedule" ? job.schedule : isObject(job.continuous) ? undefined : job.trigger;
  const condition = conditionWords(isObject(source) ? source.sql_condition : undefined);
  if (!condition) return words;
  const pausedTail = " · Paused";
  const head = words.short.endsWith(pausedTail) ? words.short.slice(0, -pausedTail.length) : words.short;
  const tail = words.short.endsWith(pausedTail) ? pausedTail : "";
  return { ...words, short: `${head} · if SQL condition${tail}`, condition };
}

function triggerWords(job: JobTriggerFields): JobTriggerWords | undefined {
  const cron = isObject(job.schedule) ? text(job.schedule.quartz_cron_expression) : undefined;
  if (cron && isObject(job.schedule)) return scheduleWords(cron, text(job.schedule.timezone_id), paused(job.schedule.pause_status));

  // `continuous: {}` is still continuous: the job runs again as soon as a run ends.
  if (isObject(job.continuous)) {
    return withPause({ label: "Trigger", short: "Continuous", full: "Runs continuously" }, paused(job.continuous.pause_status));
  }

  const trigger = job.trigger;
  if (!isObject(trigger)) return undefined;
  const isPaused = paused(trigger.pause_status);

  if (isObject(trigger.periodic)) {
    const interval = trigger.periodic.interval;
    const unit = text(trigger.periodic.unit)?.toLowerCase();
    if (typeof interval === "number" && interval > 0 && unit) {
      const words = `Every ${interval === 1 ? unit.replace(/s$/, "") : `${interval} ${unit}`}`;
      return withPause({ label: "Trigger", short: words, full: words }, isPaused);
    }
  }
  const tables = names(isObject(trigger.table_update) ? trigger.table_update.table_names : undefined);
  const oldTables = names(isObject(trigger.table) ? trigger.table.table_names : undefined);
  if (isObject(trigger.table_update) || isObject(trigger.table)) {
    const list = tables.length > 0 ? tables : oldTables;
    return withPause(
      {
        label: "Trigger",
        short: "On table update",
        full: list.length === 1 ? "When 1 table is updated" : list.length > 1 ? `When ${list.length} tables are updated` : "When a table is updated",
        ...(list.length > 0 ? { detail: list } : {}),
      },
      isPaused,
    );
  }
  if (isObject(trigger.file_arrival)) {
    const url = text(trigger.file_arrival.url);
    return withPause(
      { label: "Trigger", short: "On file arrival", full: "When new files arrive", ...(url ? { detail: [url] } : {}) },
      isPaused,
    );
  }
  return undefined;
}

/** A synced table's sync mode (issue 737), from the CLI schema's description of scheduling_policy. */
const SYNC_MODES: Record<string, { short: string; full: string }> = {
  CONTINUOUS: { short: "Continuous", full: "Keeps running and applies source changes as they happen" },
  TRIGGERED: { short: "Triggered", full: "Applies source changes each time its pipeline is run" },
  SNAPSHOT: { short: "Snapshot", full: "Copies the whole source table each time its pipeline is run" },
};

export function syncModeWords(policy: unknown): JobTriggerWords | undefined {
  const mode = typeof policy === "string" ? SYNC_MODES[policy.trim().toUpperCase()] : undefined;
  return mode && { label: "Sync", ...mode };
}

/**
 * A materialization set's schedules (issue 737), one per feature. The cron's format isn't stated
 * (the schema's example has 5 fields, Quartz has 6 or 7), so it is shown as written, never in words.
 */
export function featureScheduleWords(features: unknown): JobTriggerWords | undefined {
  const rows = (Array.isArray(features) ? features : []).flatMap((entry) => {
    if (!isObject(entry)) return [];
    const name = text(entry.feature_name) ?? "feature";
    const cron = isObject(entry.cron_schedule_trigger) ? entry.cron_schedule_trigger : undefined;
    if (cron) {
      const derived = text(cron.mode)?.toUpperCase() === "DERIVED";
      const expression = text(cron.cron_expression);
      const zone = text(cron.timezone_id);
      const when = derived ? "schedule set by Databricks" : expression ? `${expression}${zone ? ` (${zone})` : ""}` : undefined;
      if (!when) return [];
      return [{ line: `${name}: ${when}${cron.paused === true ? " (paused)" : ""}`, short: "Scheduled", paused: cron.paused === true }];
    }
    if (isObject(entry.table_trigger)) return [{ line: `${name}: when its source table changes`, short: "On table update", paused: false }];
    return [];
  });
  if (rows.length === 0) return undefined;
  const shorts = new Set(rows.map((row) => row.short));
  const allPaused = rows.every((row) => row.paused);
  return {
    label: "Schedule",
    short: `${shorts.size === 1 ? rows[0]!.short : "Scheduled"}${allPaused ? " · Paused" : ""}`,
    full: rows.length === 1 ? "1 feature with a schedule" : `${rows.length} features with a schedule`,
    detail: rows.map((row) => row.line),
  };
}

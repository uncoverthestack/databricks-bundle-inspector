import { describeCronExpression } from "./graph/cronDescription.js";

/**
 * What starts a job, in words (issue 733). `short` is the few words on the overview box: never a
 * table name, a path or a raw cron. `full` and `detail` are for the job's details.
 */
export interface JobTriggerWords {
  /** "Schedule" for `schedule`, else "Trigger". */
  label: "Schedule" | "Trigger";
  short: string;
  full: string;
  /** The raw cron, or the tables, when they add to `full`. */
  detail?: string[];
}

interface JobTriggerFields {
  schedule?: { quartz_cron_expression?: unknown; timezone_id?: unknown; pause_status?: unknown };
  continuous?: unknown;
  trigger?: {
    file_arrival?: { url?: unknown };
    table_update?: { table_names?: unknown };
    table?: { table_names?: unknown };
    periodic?: { interval?: unknown; unit?: unknown };
    pause_status?: unknown;
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

/** The job's schedule or trigger in words, or undefined when it sets none. */
export function jobTriggerWords(job: JobTriggerFields): JobTriggerWords | undefined {
  const cron = isObject(job.schedule) ? text(job.schedule.quartz_cron_expression) : undefined;
  if (cron && isObject(job.schedule)) {
    const timezone = text(job.schedule.timezone_id);
    const words = describeCronExpression(cron);
    const described = words !== cron;
    const plain = described ? words.replace(/^Runs e/, "E") : "";
    return withPause(
      {
        label: "Schedule",
        short: described && plain.length <= SHORT_MAX ? plain : "Scheduled",
        full: described ? `${plain}${timezone ? ` (${timezone})` : ""}` : `Cron schedule${timezone ? ` (${timezone})` : ""}`,
        detail: [cron],
      },
      paused(job.schedule.pause_status),
    );
  }

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

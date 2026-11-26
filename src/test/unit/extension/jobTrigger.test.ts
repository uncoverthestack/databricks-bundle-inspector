import { describe, expect, test } from "@jest/globals";
import { jobTriggerWords } from "../../../bundle/jobTrigger.js";

const short = (job: Parameters<typeof jobTriggerWords>[0]) => jobTriggerWords(job)?.short;

describe("jobTriggerWords (#733)", () => {
  test("a schedule: words on the box, time zone and cron in the details", () => {
    expect(jobTriggerWords({ schedule: { quartz_cron_expression: "0 0 * * * ?", timezone_id: "UTC" } })).toEqual({
      label: "Schedule",
      short: "Every hour",
      full: "Every hour (UTC)",
      detail: ["0 0 * * * ?"],
    });
    expect(short({ schedule: { quartz_cron_expression: "0 0 2 * * ?" } })).toBe("Every day at 02:00");
    expect(short({ schedule: { quartz_cron_expression: "0 0 9 ? * MON-FRI" } })).toBe("Every weekday (Mon–Fri) at 09:00");
  });

  test("a schedule the words can't say, or that is too long for the box, says Scheduled", () => {
    expect(jobTriggerWords({ schedule: { quartz_cron_expression: "44 19 */1 * * ?", timezone_id: "Europe/Amsterdam" } })).toEqual({
      label: "Schedule",
      short: "Scheduled",
      full: "Cron schedule (Europe/Amsterdam)",
      detail: ["44 19 */1 * * ?"],
    });
    expect(short({ schedule: { quartz_cron_expression: "${var.cron}" } })).toBe("Scheduled");
    // "Every 4 hours, on Monday, Wednesday, Friday" is over the box's limit; the details keep it.
    const long = jobTriggerWords({ schedule: { quartz_cron_expression: "0 0 0/4 ? * MON,WED,FRI" } });
    expect([long?.short, long?.full]).toEqual(["Scheduled", "Every 4 hours, on Monday, Wednesday, Friday"]);
  });

  test("continuous, also when empty", () => {
    expect(jobTriggerWords({ continuous: {} })).toEqual({ label: "Trigger", short: "Continuous", full: "Runs continuously" });
    expect(short({ continuous: { pause_status: "UNPAUSED" } })).toBe("Continuous");
  });

  test("paused adds a word, in any case", () => {
    expect(short({ continuous: { pause_status: "PAUSED" } })).toBe("Continuous · Paused");
    expect(jobTriggerWords({ schedule: { quartz_cron_expression: "0 0 2 * * ?", pause_status: "paused" } })?.full).toBe("Every day at 02:00 (paused)");
    expect(short({ trigger: { file_arrival: { url: "/Volumes/a/b/c/" }, pause_status: "PAUSED" } })).toBe("On file arrival · Paused");
  });

  test("triggers never put tables or paths on the box", () => {
    const tables = jobTriggerWords({ trigger: { table_update: { table_names: ["main.sales.orders", "main.sales.customers", "main.sales.returns"] } } });
    expect(tables).toEqual({
      label: "Trigger",
      short: "On table update",
      full: "When 3 tables are updated",
      detail: ["main.sales.orders", "main.sales.customers", "main.sales.returns"],
    });
    expect(jobTriggerWords({ trigger: { table: { table_names: ["main.a.b"] } } })?.full).toBe("When 1 table is updated");
    expect(jobTriggerWords({ trigger: { file_arrival: { url: "/Volumes/main/raw/landing/" } } })).toEqual({
      label: "Trigger",
      short: "On file arrival",
      full: "When new files arrive",
      detail: ["/Volumes/main/raw/landing/"],
    });
    expect(short({ trigger: { periodic: { interval: 4, unit: "HOURS" } } })).toBe("Every 4 hours");
    expect(short({ trigger: { periodic: { interval: 1, unit: "DAYS" } } })).toBe("Every day");
  });

  test("near miss: nothing set, an empty schedule, or a trigger with no kind gives nothing", () => {
    expect(jobTriggerWords({})).toBeUndefined();
    expect(jobTriggerWords({ schedule: {} })).toBeUndefined();
    expect(jobTriggerWords({ schedule: { quartz_cron_expression: "  " } })).toBeUndefined();
    expect(jobTriggerWords({ trigger: { pause_status: "PAUSED" } })).toBeUndefined();
    expect(jobTriggerWords({ continuous: "yes" })).toBeUndefined();
  });
});

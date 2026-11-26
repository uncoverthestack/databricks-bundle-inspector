import { describe, expect, test } from "@jest/globals";
import { resourceScheduleWords } from "../../../bundle/bundleOverview.js";
import { featureScheduleWords, jobTriggerWords, syncModeWords } from "../../../bundle/jobTrigger.js";

describe("job SQL conditions (#737)", () => {
  test("on a schedule: the box adds 'if SQL condition', the details say when it runs and where", () => {
    expect(
      jobTriggerWords({
        schedule: { quartz_cron_expression: "0 0 * * * ?", timezone_id: "UTC", sql_condition: { warehouse_id: "abc", sql_query_id: "q1", trigger_mode: "QUERY_RETURNS_ROWS" } },
      }),
    ).toEqual({
      label: "Schedule",
      short: "Every hour · if SQL condition",
      full: "Every hour (UTC)",
      detail: ["0 0 * * * ?"],
      condition: ["Runs only when query q1 returns rows", "On warehouse abc"],
    });
  });

  test("on a paused trigger, with RESULT_VALUE_CHANGES: Paused stays last", () => {
    const words = jobTriggerWords({
      trigger: { pause_status: "PAUSED", table_update: { table_names: ["a.b.c"] }, sql_condition: { warehouse_id: "abc", sql_query_id: "q2", trigger_mode: "RESULT_VALUE_CHANGES" } },
    });
    expect([words?.short, words?.condition]).toEqual(["On table update · if SQL condition · Paused", ["Runs only when query q2's value changes", "On warehouse abc"]]);
  });

  test("no query or warehouse still says there is a condition; no trigger_mode reads as returns rows", () => {
    expect(jobTriggerWords({ schedule: { quartz_cron_expression: "0 0 * * * ?", sql_condition: {} } })?.condition).toEqual([
      "Runs only when its SQL condition is met",
    ]);
    expect(jobTriggerWords({ schedule: { quartz_cron_expression: "0 0 * * * ?", sql_condition: { sql_query_id: "q" } } })?.condition).toEqual([
      "Runs only when query q returns rows",
    ]);
  });

  test("near miss: a condition on the field not in use, or not an object, is not said", () => {
    // The schedule wins, so a condition on the trigger is not the one that applies.
    expect(jobTriggerWords({ schedule: { quartz_cron_expression: "0 0 * * * ?" }, trigger: { sql_condition: { sql_query_id: "q" } } })?.condition).toBeUndefined();
    expect(jobTriggerWords({ continuous: {}, trigger: { sql_condition: { sql_query_id: "q" } } })?.condition).toBeUndefined();
    expect(jobTriggerWords({ schedule: { quartz_cron_expression: "0 0 * * * ?", sql_condition: "yes" } })?.short).toBe("Every hour");
  });
});

describe("synced table sync mode (#737)", () => {
  test("each mode, in any case", () => {
    expect(syncModeWords("CONTINUOUS")).toEqual({ label: "Sync", short: "Continuous", full: "Keeps running and applies source changes as they happen" });
    expect(syncModeWords("triggered")?.short).toBe("Triggered");
    expect(syncModeWords("SNAPSHOT")?.full).toBe("Copies the whole source table each time its pipeline is run");
  });

  test("both resources: postgres_synced_tables at the top, synced_database_tables under spec", () => {
    expect(resourceScheduleWords("postgres_synced_tables", { scheduling_policy: "CONTINUOUS" })?.short).toBe("Continuous");
    expect(resourceScheduleWords("synced_database_tables", { spec: { scheduling_policy: "SNAPSHOT" } })?.short).toBe("Snapshot");
  });

  test("near miss: unset, unknown, or in the wrong place", () => {
    expect(syncModeWords(undefined)).toBeUndefined();
    expect(syncModeWords("SOMETIMES")).toBeUndefined();
    expect(resourceScheduleWords("synced_database_tables", { scheduling_policy: "SNAPSHOT" })).toBeUndefined();
  });
});

describe("materialization set schedules (#737)", () => {
  test("crons are shown as written, never in words; a table trigger in words", () => {
    expect(
      featureScheduleWords([
        { feature_name: "main.ml.spend_7d", cron_schedule_trigger: { cron_expression: "0 0 * * *", timezone_id: "UTC" } },
        { feature_name: "main.ml.visits_1d", table_trigger: {} },
      ]),
    ).toEqual({
      label: "Schedule",
      short: "Scheduled",
      full: "2 features with a schedule",
      detail: ["main.ml.spend_7d: 0 0 * * * (UTC)", "main.ml.visits_1d: when its source table changes"],
    });
  });

  test("all on table triggers says so; all paused says Paused; DERIVED is set by Databricks", () => {
    expect(featureScheduleWords([{ feature_name: "a", table_trigger: {} }])?.short).toBe("On table update");
    const paused = featureScheduleWords([{ feature_name: "a", cron_schedule_trigger: { cron_expression: "0 0 * * *", paused: true } }]);
    expect([paused?.short, paused?.detail]).toEqual(["Scheduled · Paused", ["a: 0 0 * * * (paused)"]]);
    expect(featureScheduleWords([{ feature_name: "a", cron_schedule_trigger: { mode: "DERIVED" } }])?.detail).toEqual(["a: schedule set by Databricks"]);
  });

  test("near miss: no features, external triggers only, or an empty cron give nothing", () => {
    expect(featureScheduleWords(undefined)).toBeUndefined();
    expect(featureScheduleWords([{ feature_name: "a", external_trigger: {} }])).toBeUndefined();
    expect(featureScheduleWords([{ feature_name: "a", cron_schedule_trigger: {} }])).toBeUndefined();
  });
});

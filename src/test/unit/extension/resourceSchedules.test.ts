import { describe, expect, test } from "@jest/globals";
import { buildBundleOverview, resourceScheduleWords } from "../../../bundle/bundleOverview.js";
import { itemNote } from "../../../webview/lib/overviewView.js";

describe("alert and monitor schedules (#541)", () => {
  test("an alert: quartz_cron_schedule, time zone and paused", () => {
    expect(
      resourceScheduleWords("alerts", { schedule: { quartz_cron_schedule: "44 19 */1 * * ?", timezone_id: "Europe/Amsterdam", pause_status: "PAUSED" } }),
    ).toEqual({
      label: "Schedule",
      short: "Every hour · Paused",
      full: "Every hour at 19 minutes 44 seconds past (Europe/Amsterdam) (paused)",
      detail: ["44 19 */1 * * ?"],
    });
  });

  test("a quality monitor reads quartz_cron_expression", () => {
    expect(resourceScheduleWords("quality_monitors", { schedule: { quartz_cron_expression: "0 0 2 * * ?", timezone_id: "UTC" } })?.short).toBe(
      "Every day at 02:00",
    );
  });

  test("a data quality monitor reads data_profiling_config.schedule, and never says paused (read-only)", () => {
    const words = resourceScheduleWords("data_quality_monitors", {
      data_profiling_config: { schedule: { quartz_cron_expression: "0 30 6 ? * MON-FRI", timezone_id: "UTC", pause_status: "PAUSED" } },
    });
    expect([words?.short, words?.full]).toEqual(["Every weekday (Mon–Fri) at 06:30", "Every weekday (Mon–Fri) at 06:30 (UTC)"]);
  });

  test("near miss: wrong field name, no schedule, an empty cron, or another resource give nothing", () => {
    expect(resourceScheduleWords("alerts", { schedule: { quartz_cron_expression: "0 0 2 * * ?" } })).toBeUndefined();
    expect(resourceScheduleWords("quality_monitors", { schedule: { quartz_cron_schedule: "0 0 2 * * ?" } })).toBeUndefined();
    expect(resourceScheduleWords("quality_monitors", {})).toBeUndefined();
    expect(resourceScheduleWords("data_quality_monitors", { data_profiling_config: { schedule: { quartz_cron_expression: " " } } })).toBeUndefined();
    expect(resourceScheduleWords("dashboards", { schedule: { quartz_cron_expression: "0 0 2 * * ?" } })).toBeUndefined();
  });

  test("the box note says the schedule after the type", () => {
    const node = (group: string, key: string, data: Record<string, unknown>) => ({
      id: `resources.${group}.${key}`,
      nodeType: "resource",
      displayName: key,
      resourceGroup: group,
      resourceKey: key,
      data,
    });
    const overview = buildBundleOverview({
      nodes: [node("alerts", "revenue", { schedule: { quartz_cron_schedule: "0 0 * * * ?", timezone_id: "UTC" } }), node("alerts", "unscheduled", {})],
      edges: [],
    });
    const items = overview.groups.flatMap((group) => group.items);
    expect(itemNote(overview, items.find((item) => item.label === "revenue")!)).toBe("alert · Every hour");
    expect(itemNote(overview, items.find((item) => item.label === "unscheduled")!)).toBe("alert");
  });
});

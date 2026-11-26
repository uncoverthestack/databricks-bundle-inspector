import { describe, expect, test } from "@jest/globals";
import { buildBundleOverview } from "../../../bundle/bundleOverview.js";
import { jobOwnSettings } from "../../../bundle/computeSettings.js";

const titles = (config: Record<string, unknown>) => jobOwnSettings(config).sections.map((section) => section.title);

describe("jobOwnSettings (#735)", () => {
  test("every section, in order, when the bundle sets it", () => {
    const settings = jobOwnSettings({
      run_as: { service_principal_name: "etl-prod" },
      parameters: [
        { name: "run_date", default: "{{job.start_time.iso_date}}" },
        { name: "env", default: "dev" },
        { name: "a", default: "1" },
        { name: "b", default: "2" },
      ],
      timeout_seconds: 7200,
      max_concurrent_runs: 1,
      email_notifications: { on_failure: ["data-team@example.com"] },
      webhook_notifications: { on_failure: [{ id: "abc" }, { id: "def" }] },
    });
    expect(settings).toEqual({
      sections: [
        { title: "Runs as", rows: [{ label: "Service principal", value: "etl-prod" }] },
        {
          title: "Job parameters",
          // All four, never cut to the first few.
          rows: [
            { label: "run_date", value: "{{job.start_time.iso_date}}" },
            { label: "env", value: "dev" },
            { label: "a", value: "1" },
            { label: "b", value: "2" },
          ],
        },
        { title: "Limits", rows: [{ label: "Timeout", value: "2 hours" }, { label: "Runs at once", value: "1" }] },
        {
          title: "On failure, tells",
          rows: [
            { label: "Email", value: "data-team@example.com", lines: ["data-team@example.com"] },
            { label: "Webhooks", value: "2 webhooks" },
          ],
        },
      ],
      alsoSet: [],
    });
  });

  test("a user, timeouts in words, and a variable shown as written until it resolves", () => {
    expect(jobOwnSettings({ run_as: { user_name: "a@b.com" } }).sections[0]!.rows).toEqual([{ label: "User", value: "a@b.com" }]);
    const timeout = (seconds: number) => jobOwnSettings({ timeout_seconds: seconds }).sections[0]!.rows[0]!.value;
    expect([timeout(0), timeout(45), timeout(90), timeout(120), timeout(3600)]).toEqual(["None", "45 seconds", "90 seconds", "2 minutes", "1 hour"]);
    const params = { parameters: [{ name: "env", default: "${var.env}" }] };
    expect(jobOwnSettings(params).sections[0]!.rows).toEqual([{ label: "env", value: "${var.env}", expression: true }]);
    expect(jobOwnSettings(params, () => "prod").sections[0]!.rows).toEqual([{ label: "env", value: "prod" }]);
  });

  test("an empty or missing default still lists the parameter", () => {
    expect(jobOwnSettings({ parameters: [{ name: "x", default: "" }, { name: "y" }, { name: "z", default: false }] }).sections[0]!.rows).toEqual([
      { label: "x", value: "Empty" },
      { label: "y", value: "No default" },
      { label: "z", value: "false" },
    ]);
  });

  test("near miss: unset, empty lists and nameless parameters add no section", () => {
    expect(titles({})).toEqual([]);
    expect(titles({ run_as: {}, parameters: [], email_notifications: { on_failure: [] }, webhook_notifications: { on_success: [{ id: "x" }] } })).toEqual([]);
    expect(titles({ parameters: [{ default: "1" }], email_notifications: { on_success: ["a@b.com"] } })).toEqual([]);
  });

  test("runs at once 1 the CLI adds, not written in the YAML, is left out; written, it shows", () => {
    expect(titles({ max_concurrent_runs: 1 })).toEqual(["Limits"]);
    expect(jobOwnSettings({ max_concurrent_runs: 1 }, undefined, { name: 3 }).sections).toEqual([]);
    expect(jobOwnSettings({ max_concurrent_runs: 1 }, undefined, { name: 3, max_concurrent_runs: 4 }).sections[0]!.rows).toEqual([{ label: "Runs at once", value: "1" }]);
    expect(jobOwnSettings({ max_concurrent_runs: 5 }, undefined, { name: 3 }).sections[0]!.rows).toEqual([{ label: "Runs at once", value: "5" }]);
  });

  test("the overview gives a job box its settings, and none when it sets nothing", () => {
    const job = (key: string, data: Record<string, unknown>) => ({ id: `resources.jobs.${key}`, nodeType: "job", displayName: key, resourceGroup: "jobs", resourceKey: key, data });
    const overview = buildBundleOverview({ nodes: [job("set", { max_concurrent_runs: 3 }), job("bare", {})], edges: [] });
    const items = overview.groups.flatMap((group) => group.items);
    expect(items.find((item) => item.label === "set")?.settings?.sections).toEqual([{ title: "Limits", rows: [{ label: "Runs at once", value: "3" }] }]);
    expect(items.find((item) => item.label === "bare")?.settings).toBeUndefined();
  });
});

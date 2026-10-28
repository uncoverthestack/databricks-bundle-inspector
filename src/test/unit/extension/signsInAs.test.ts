import { describe, expect, test } from "@jest/globals";
import type { ProfileSource as PlanSource } from "../../../databricksCli/signIn.js";
import { PROFILE_SOURCES, signsInAsLine, type ProfileSource } from "../../../webview/lib/signsInAs.js";

// The graph's copy of the sources must match the extension's, both ways.
const fromPlan: readonly ProfileSource[] = [] as PlanSource[];
const toPlan: readonly PlanSource[] = PROFILE_SOURCES;

describe("signsInAsLine: the banner's grey line", () => {
  const text = (source: ProfileSource, profile = "analytics") => {
    const line = signsInAsLine("dev", { profile, source });
    return `${line.lead} ${line.profile}${line.rest}`;
  };

  test("says the name and where it comes from, for each source", () => {
    expect(text("default", "DEFAULT")).toBe("Signs in as DEFAULT: dev has no workspace address, so the Databricks CLI checks it with DEFAULT.");
    expect(text("setting")).toBe("Signs in as analytics, the profile in your settings.");
    expect(text("environment")).toBe("Signs in as analytics, from DATABRICKS_CONFIG_PROFILE in your environment.");
    expect(text("bundle")).toBe("Signs in as analytics, from workspace.profile in the bundle.");
    expect(text("existing", "adb-1234")).toBe("Signs in again as adb-1234, your profile for this workspace.");
    expect(text("new", "adb-1234")).toBe("Signs in as adb-1234, a new profile named after dev's workspace address.");
  });

  test("only the Profile setting can be changed from the banner", () => {
    expect(PROFILE_SOURCES.filter((source) => signsInAsLine("dev", { profile: "p", source }).change)).toEqual(["setting"]);
    expect([fromPlan, toPlan]).toBeDefined();
  });
});

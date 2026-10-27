import { describe, expect, test } from "@jest/globals";
import {
  isSafeHost,
  newProfileName,
  parseConfigSections,
  planSignIn,
  profileUpdated,
  signInCommand,
  targetWorkspace,
} from "../../../databricksCli/signIn.js";

const CONFIG = [
  "; The CLI's header comment",
  "[DEFAULT]",
  "",
  "[web]",
  "host = https://adb-1234.azuredatabricks.net",
  "auth_type = databricks-cli",
  "",
  "[tok]",
  "host     = https://adb-1234.azuredatabricks.net  ; a comment",
  "token    = dapi-fake",
  "",
  "[nohost]",
  "token = dapi-other",
  "",
  "[ADB-9]",
  'host = "https://adb-9.azuredatabricks.net"',
  "auth_type = databricks-cli",
].join("\r\n");

describe("parseConfigSections", () => {
  test("reads every section, a profile with no host too, without quotes or inline comments", () => {
    const sections = parseConfigSections(CONFIG);
    expect([...sections.keys()]).toEqual(["DEFAULT", "web", "tok", "nohost", "ADB-9"]);
    expect(sections.get("tok")).toEqual({ host: "https://adb-1234.azuredatabricks.net", token: "dapi-fake" });
    expect(sections.get("ADB-9")?.host).toBe("https://adb-9.azuredatabricks.net");
  });
});

describe("isSafeHost and signInCommand", () => {
  test.each([
    ["https://adb-1234.5.azuredatabricks.net", true],
    ["https://dbc-a1b2.cloud.databricks.com/", true],
    ["https://adb-1234.5.azuredatabricks.net/?o=1234", true],
    ["https://host.example.com:8443", true],
    ["http://host.example.com", false],
    ["https://host.example.com/$(touch x)", false],
    ['https://host.example.com/"; rm -rf ~; "', false],
    ["https://host.example.com/%PATH%", false],
    ["https://host .example.com", false],
    ["https://host.example.com/`id`", false],
  ])("%s is safe: %s", (host, safe) => {
    expect(isSafeHost(host)).toBe(safe);
  });

  test("double-quotes both values, with no --timeout", () => {
    expect(signInCommand("https://adb-1234.azuredatabricks.net/?o=1234", "second one")).toBe(
      'databricks auth login --host "https://adb-1234.azuredatabricks.net/?o=1234" --profile "second one"',
    );
  });
});

describe("newProfileName", () => {
  test("the host's first label, unique in the file whatever the letter case", () => {
    const sections = parseConfigSections(CONFIG);
    expect(newProfileName("https://dbc-a1b2.cloud.databricks.com", sections)).toBe("dbc-a1b2");
    // "adb-9" is taken as ADB-9.
    expect(newProfileName("https://adb-9.azuredatabricks.net", sections)).toBe("adb-9-2");
    expect(newProfileName("https://default.example.com", sections)).toBe("default-2");
  });
});

describe("planSignIn: never a name that would be replaced", () => {
  const sections = parseConfigSections(CONFIG);
  const host = "https://adb-1234.azuredatabricks.net";

  test("reuses a browser profile for that workspace, not the token profile next to it", () => {
    expect(planSignIn({ host, profile: undefined, sections })).toEqual({ kind: "ready", host, profile: "web", reuses: true });
  });

  test("a new name when no browser profile has the workspace", () => {
    expect(planSignIn({ host: "https://dbc-a1b2.cloud.databricks.com", profile: undefined, sections })).toEqual({
      kind: "ready",
      host: "https://dbc-a1b2.cloud.databricks.com",
      profile: "dbc-a1b2",
      reuses: false,
    });
  });

  test("the profile the checks use, when it doesn't exist yet", () => {
    expect(planSignIn({ host, profile: "team-dev", sections })).toEqual({ kind: "ready", host, profile: "team-dev", reuses: false });
  });

  test("not under a token profile's name, with or without a host in it", () => {
    for (const profile of ["tok", "nohost"]) {
      const plan = planSignIn({ host, profile, sections });
      expect(plan.kind).toBe("blocked");
      expect(plan.kind === "blocked" && plan.reason).toMatch(/signs in another way/);
    }
  });

  test("not under a browser profile for another workspace, which would change its host", () => {
    expect(planSignIn({ host, profile: "ADB-9", sections })).toEqual({
      kind: "blocked",
      reason: 'the "ADB-9" profile is for a different workspace',
    });
  });

  test("takes the host from the profile when the bundle has none, else asks", () => {
    expect(planSignIn({ host: undefined, profile: "web", sections })).toEqual({ kind: "ready", host, profile: "web", reuses: true });
    expect(planSignIn({ host: undefined, profile: "team-dev", sections })).toEqual({ kind: "needs_host", profile: "team-dev" });
    expect(planSignIn({ host: undefined, profile: undefined, sections })).toEqual({ kind: "needs_host" });
  });

  test("not with a host or profile name a terminal would read", () => {
    expect(planSignIn({ host: "https://x.example.com/$(id)", profile: undefined, sections }).kind).toBe("blocked");
    expect(planSignIn({ host, profile: 'a"b', sections }).kind).toBe("blocked");
    expect(planSignIn({ host, profile: "__settings__", sections }).kind).toBe("blocked");
  });
});

describe("targetWorkspace", () => {
  const bundle = [
    "bundle: { name: b }",
    "workspace:",
    "  host: https://top.example.com",
    "x-dev: &dev",
    "  workspace:",
    "    profile: from-anchor",
    "targets:",
    "  dev:",
    "    <<: *dev",
    "  prod:",
    "    workspace:",
    "      host: https://prod.example.com",
    "      profile: ${var.who}",
  ].join("\n");

  test("the target's own values over the bundle's, merges read, variables left out", () => {
    expect(targetWorkspace([bundle], "dev")).toEqual({ host: "https://top.example.com", profile: "from-anchor" });
    expect(targetWorkspace([bundle], "prod")).toEqual({ host: "https://prod.example.com" });
    expect(targetWorkspace([bundle], "missing")).toEqual({ host: "https://top.example.com" });
  });

  test("a target defined in an included file", () => {
    const included = "targets:\n  staging:\n    workspace:\n      host: https://staging.example.com\n";
    expect(targetWorkspace([bundle, included], "staging")).toEqual({ host: "https://staging.example.com" });
  });
});

describe("profileUpdated: only the profile being signed in", () => {
  const host = "https://adb-1234.azuredatabricks.net";
  const browser = { host, auth_type: "databricks-cli" };

  test("a new browser profile for the workspace", () => {
    expect(profileUpdated({ before: undefined, after: browser, host, backupChanged: false })).toBe(true);
  });

  test("a profile that was already there counts once the CLI rewrote the file", () => {
    expect(profileUpdated({ before: browser, after: { ...browser }, host, backupChanged: false })).toBe(false);
    expect(profileUpdated({ before: browser, after: { ...browser }, host, backupChanged: true })).toBe(true);
    expect(profileUpdated({ before: browser, after: { ...browser, workspace_id: "1234" }, host, backupChanged: false })).toBe(true);
  });

  test("not when the profile is missing, not a browser one, or for another workspace", () => {
    expect(profileUpdated({ before: undefined, after: undefined, host, backupChanged: true })).toBe(false);
    expect(profileUpdated({ before: undefined, after: { host, token: "x" }, host, backupChanged: true })).toBe(false);
    expect(profileUpdated({ before: undefined, after: { ...browser, host: "https://other.example.com" }, host, backupChanged: true })).toBe(false);
  });
});

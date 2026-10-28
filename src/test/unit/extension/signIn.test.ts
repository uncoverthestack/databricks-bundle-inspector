import { describe, expect, test } from "@jest/globals";
import {
  isSafeHost,
  newProfileName,
  otherProfileSignedIn,
  parseConfigSections,
  planSignIn,
  profileUpdated,
  signInCommand,
  signsInAs,
  targetWorkspace,
  terminalCli,
  type ConfigSections,
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

const parse = (text: string): ConfigSections => {
  const sections = parseConfigSections(text);
  if (!sections) throw new Error("the test config should parse");
  return sections;
};

describe("parseConfigSections", () => {
  test("reads every section, a profile with no host too, without quotes or inline comments", () => {
    const sections = parse(CONFIG);
    expect([...sections.keys()]).toEqual(["DEFAULT", "web", "tok", "nohost", "ADB-9"]);
    expect(sections.get("tok")).toEqual({ host: "https://adb-1234.azuredatabricks.net", token: "dapi-fake" });
    expect(sections.get("ADB-9")?.host).toBe("https://adb-9.azuredatabricks.net");
  });

  // As `databricks auth profiles` listed this file on CLI 0.299.0 and 1.21.0.
  test("reads names and keys as the CLI does", () => {
    const sections = parse(
      [
        "host = https://top.example.invalid",
        "token = fake-top",
        "[protected] # keep this token",
        "host = https://p.example.invalid",
        "token = fake",
        "[semi] ; note",
        "[bracket] # see [other]",
        "[colon]",
        "host: https://colon.example.invalid",
        "auth_type: databricks-cli",
        "[ spaced ]",
      ].join("\n"),
    );
    expect([...sections.keys()]).toEqual(["DEFAULT", "protected", "semi", "bracket] # see [other", "colon", " spaced "]);
    expect(sections.get("DEFAULT")).toEqual({ host: "https://top.example.invalid", token: "fake-top" });
    expect(sections.get("protected")?.token).toBe("fake");
    expect(sections.get("colon")).toEqual({ host: "https://colon.example.invalid", auth_type: "databricks-cli" });
  });

  test("nothing when a line is one the CLI refuses the file for", () => {
    expect(parseConfigSections("[ok]\nhost = https://x.example.invalid\nnot a key value line")).toBeUndefined();
    expect(parseConfigSections("[unclosed\nhost = x")).toBeUndefined();
    expect(parseConfigSections("[]\nhost = x")).toBeUndefined();
    expect(parseConfigSections("= no key")).toBeUndefined();
    expect(parseConfigSections("")).toEqual(new Map());
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
    expect(signInCommand("https://h.example.com", "p", "/opt/cli/databricks-custom")).toBe(
      '/opt/cli/databricks-custom auth login --host "https://h.example.com" --profile "p"',
    );
  });
});

describe("terminalCli: the terminal runs the CLI file the checks use", () => {
  test("a file named databricks is found by name with its folder first on PATH", () => {
    expect(terminalCli("/opt/homebrew/bin/databricks", "darwin")).toEqual({ command: "databricks", folder: "/opt/homebrew/bin" });
    expect(terminalCli("C:\\Program Files\\Databricks\\databricks.exe", "win32")).toEqual({
      command: "databricks",
      folder: "C:\\Program Files\\Databricks",
    });
    expect(terminalCli("C:\\tools\\DATABRICKS.CMD", "win32")).toEqual({ command: "databricks", folder: "C:\\tools" });
  });

  test("another name is typed as its path, which PATH would not find", () => {
    expect(terminalCli("/tmp/x/databricks-custom", "darwin")).toEqual({ command: "/tmp/x/databricks-custom" });
    // On macOS and Linux, `databricks` doesn't find databricks.sh or databricks.exe.
    expect(terminalCli("/tmp/x/databricks.sh", "linux")).toEqual({ command: "/tmp/x/databricks.sh" });
    expect(terminalCli("C:\\tools\\databricks-1.21.exe", "win32")).toEqual({ command: "C:\\tools\\databricks-1.21.exe" });
  });

  test("a folder with the PATH separator in it is typed as its path, as PATH would split it in two", () => {
    expect(terminalCli("/tmp/cli:1.21/databricks", "darwin")).toEqual({ command: "/tmp/cli:1.21/databricks" });
    // On Windows the separator is `;`, which a shell would read, so nothing is typed.
    expect(terminalCli("C:\\tools;old\\databricks.exe", "win32")).toBeUndefined();
  });

  test("not a path with spaces or characters a shell would read", () => {
    expect(terminalCli("/Users/me/my tools/databricks-custom", "darwin")).toBeUndefined();
    expect(terminalCli("/tmp/$(id)/dbx", "darwin")).toBeUndefined();
    expect(terminalCli("~/bin/dbx", "darwin")).toBeUndefined();
    expect(terminalCli("C:\\Program Files\\dbx.exe", "win32")).toBeUndefined();
  });
});

describe("newProfileName", () => {
  test("the host's first label, unique in the file whatever the letter case", () => {
    const sections = parse(CONFIG);
    expect(newProfileName("https://dbc-a1b2.cloud.databricks.com", sections)).toBe("dbc-a1b2");
    // "adb-9" is taken as ADB-9.
    expect(newProfileName("https://adb-9.azuredatabricks.net", sections)).toBe("adb-9-2");
    expect(newProfileName("https://default.example.com", sections)).toBe("default-2");
  });
});

describe("planSignIn: a target with no host, which the CLI checks with DEFAULT alone", () => {
  const host = "https://adb-1234.azuredatabricks.net";
  const plan = (config: string, profile?: string) =>
    planSignIn({ host, profile, sections: parse(config), defaultOnly: true });

  test("DEFAULT when it is missing or empty, even with a browser profile for the workspace under another name", () => {
    expect(plan("")).toEqual({ kind: "ready", host, profile: "DEFAULT", reuses: false });
    expect(plan("[DEFAULT]\n")).toEqual({ kind: "ready", host, profile: "DEFAULT", reuses: true });
    expect(plan(`[web]\nhost = ${host}\nauth_type = databricks-cli\n`)).toMatchObject({ kind: "ready", profile: "DEFAULT" });
  });

  test("an existing browser DEFAULT for the workspace is reused, its host used when none was asked", () => {
    const config = `[DEFAULT]\nhost = ${host}\nauth_type = databricks-cli\n`;
    expect(plan(config)).toEqual({ kind: "ready", host, profile: "DEFAULT", reuses: true });
    expect(planSignIn({ host: undefined, profile: undefined, sections: parse(config), defaultOnly: true })).toMatchObject({
      kind: "ready",
      profile: "DEFAULT",
    });
  });

  test("not when DEFAULT has a token, keys before any header included, or is for another workspace", () => {
    for (const config of [`[DEFAULT]\nhost = ${host}\ntoken = x\n`, `host = ${host}\ntoken = x\n`]) {
      expect(plan(config)).toEqual({
        kind: "blocked",
        reason:
          "this target has no workspace address, so the Databricks CLI checks it with the DEFAULT profile, which signs in another way, such as with a token, and signing in under its name would replace that. Pick a profile in the Profile setting to sign in from the graph",
      });
    }
    expect(plan("[DEFAULT]\nhost = https://other.example.com\nauth_type = databricks-cli\n")).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("DEFAULT profile, which is for a different workspace."),
    });
  });

  test("a profile named in Settings, the environment or the bundle comes first, as the CLI uses it", () => {
    expect(plan("", "mine")).toEqual({ kind: "ready", host, profile: "mine", reuses: false });
  });
});

describe("planSignIn: never a name that would be replaced", () => {
  const sections = parse(CONFIG);
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

  test("a token profile named with a comment after its header is still protected", () => {
    const commented = parse("[protected] # keep this token\nhost = https://p.example.invalid\ntoken = fake\n");
    const plan = planSignIn({ host: "https://p.example.invalid", profile: "protected", sections: commented });
    expect(plan.kind === "blocked" && plan.reason).toMatch(/signs in another way/);
  });

  test("a host set with a variable is asked for; a profile set with one blocks", () => {
    expect(planSignIn({ host: null, profile: "web", sections })).toEqual({ kind: "needs_host", profile: "web" });
    expect(planSignIn({ host: null, profile: undefined, sections })).toEqual({ kind: "needs_host" });
    expect(planSignIn({ host, profile: null, sections })).toEqual({
      kind: "blocked",
      reason: "its profile is set with a variable, which only the Databricks CLI fills in",
    });
  });
});

describe("signsInAs: the name a plan signs in as, and why", () => {
  const sections = parse(CONFIG);
  const host = "https://adb-1234.azuredatabricks.net";
  const why = (options: Parameters<typeof planSignIn>[0], named?: "setting" | "environment" | "bundle") =>
    signsInAs(planSignIn(options), { named, defaultOnly: options.defaultOnly ?? false });

  test("DEFAULT for a target with no address, before the address is asked for and after", () => {
    const dev = { host: undefined, profile: undefined, sections: parse(""), defaultOnly: true };
    expect(planSignIn(dev)).toEqual({ kind: "needs_host", profile: "DEFAULT" });
    expect(why(dev)).toEqual({ profile: "DEFAULT", source: "default" });
    expect(why({ ...dev, host })).toEqual({ profile: "DEFAULT", source: "default" });
  });

  test("a name set in Settings, the environment or the bundle says where it is set, ahead of DEFAULT", () => {
    for (const named of ["setting", "environment", "bundle"] as const) {
      expect(why({ host, profile: "mine", sections }, named)).toEqual({ profile: "mine", source: named });
      // The setting wins over DEFAULT for a target with no address, as in the Windows test.
      expect(why({ host: undefined, profile: "mine", sections, defaultOnly: true }, named)).toEqual({ profile: "mine", source: named });
    }
  });

  test("a browser profile for the workspace is reused; otherwise a new name from the address", () => {
    expect(why({ host, profile: undefined, sections })).toEqual({ profile: "web", source: "existing" });
    expect(why({ host: "https://dbc-a1b2.cloud.databricks.com", profile: undefined, sections })).toEqual({
      profile: "dbc-a1b2",
      source: "new",
    });
  });

  test("nothing when the name isn't known yet or signing in isn't offered", () => {
    // An address set with a variable is asked for, and the new name depends on it.
    expect(why({ host: null, profile: undefined, sections })).toBeUndefined();
    expect(why({ host, profile: "tok", sections }, "setting")).toBeUndefined();
    expect(why({ host, profile: null, sections }, "bundle")).toBeUndefined();
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

  test("the target's own values over the bundle's, merges read, a variable unknown", () => {
    expect(targetWorkspace([bundle], "dev")).toEqual({ host: "https://top.example.com", profile: "from-anchor" });
    expect(targetWorkspace([bundle], "prod")).toEqual({ host: "https://prod.example.com", profile: null });
    expect(targetWorkspace([bundle], "missing")).toEqual({ host: "https://top.example.com" });
  });

  test("a target defined in an included file", () => {
    const included = "targets:\n  staging:\n    workspace:\n      host: https://staging.example.com\n";
    expect(targetWorkspace([bundle, included], "staging")).toEqual({ host: "https://staging.example.com" });
  });

  test("a target's variable hides the bundle's own value, here and from an included file", () => {
    const top = "workspace:\n  host: https://prod.example.invalid\n  profile: prod\n";
    const dev = "targets:\n  dev:\n    workspace:\n      host: ${var.dev_host}\n      profile: ${var.dev_profile}\n";
    expect(targetWorkspace([top + dev], "dev")).toEqual({ host: null, profile: null });
    expect(targetWorkspace([top, dev], "dev")).toEqual({ host: null, profile: null });
    // A variable at the top is unknown too.
    expect(targetWorkspace(["workspace:\n  profile: ${var.p}\n"], "dev")).toEqual({ profile: null });
  });
});

describe("profileUpdated: only the profile being signed in", () => {
  const host = "https://adb-1234.azuredatabricks.net";
  const browser = { host, auth_type: "databricks-cli" };
  const other = { host: "https://other.example.com", auth_type: "databricks-cli" };
  const sections = (entries: Record<string, Record<string, string>>): ConfigSections => new Map(Object.entries(entries));
  const updated = (before: ConfigSections, after: ConfigSections, backupChanged: boolean) =>
    profileUpdated({ before, after, profile: "web", host, backupChanged });

  test("a new browser profile for the workspace", () => {
    expect(updated(sections({}), sections({ web: browser }), false)).toBe(true);
  });

  test("a profile that was already there counts once the CLI rewrote the file", () => {
    expect(updated(sections({ web: browser }), sections({ web: { ...browser } }), false)).toBe(false);
    expect(updated(sections({ web: browser }), sections({ web: { ...browser } }), true)).toBe(true);
    expect(updated(sections({ web: browser }), sections({ web: { ...browser, workspace_id: "1234" } }), false)).toBe(true);
  });

  test("not a sign-in to another profile, which rewrites the file and its copy too", () => {
    expect(updated(sections({ web: browser }), sections({ web: browser, other }), true)).toBe(false);
    expect(updated(sections({ web: browser, other }), sections({ web: browser, other: { ...other, workspace_id: "9" } }), true)).toBe(false);
  });

  test("not when the profile is missing, not a browser one, or for another workspace", () => {
    expect(updated(sections({}), sections({}), true)).toBe(false);
    expect(updated(sections({}), sections({ web: { host, token: "x" } }), true)).toBe(false);
    expect(updated(sections({}), sections({ web: { ...browser, host: "https://other.example.com" } }), true)).toBe(false);
  });
});

describe("otherProfileSignedIn: a sign-in for the workspace under another name", () => {
  const host = "https://adb-1234.azuredatabricks.net";
  const browser = { host, auth_type: "databricks-cli" };
  const sections = (entries: Record<string, Record<string, string>>): ConfigSections => new Map(Object.entries(entries));
  const other = (before: ConfigSections, after: ConfigSections) => otherProfileSignedIn({ before, after, profile: "adb-1234", host });

  test("a new browser profile for the workspace, under the user's own name", () => {
    expect(other(sections({}), sections({ example: browser }))).toBe("example");
  });

  test("the same workspace written another way still counts", () => {
    expect(other(sections({}), sections({ example: { host: "ADB-1234.azuredatabricks.net/", auth_type: "databricks-cli" } }))).toBe("example");
  });

  test("an existing profile whose settings changed", () => {
    const before = sections({ example: { host, auth_type: "pat" } });
    expect(other(before, sections({ example: browser }))).toBe("example");
  });

  test("not the profile that was typed, which profileUpdated checks", () => {
    expect(other(sections({}), sections({ "adb-1234": browser }))).toBeUndefined();
  });

  test("not another workspace, a token profile, or a profile left as it was", () => {
    expect(other(sections({}), sections({ example: { host: "https://other.example.com", auth_type: "databricks-cli" } }))).toBeUndefined();
    expect(other(sections({}), sections({ example: { host, token: "x" } }))).toBeUndefined();
    expect(other(sections({ example: browser }), sections({ example: browser }))).toBeUndefined();
  });
});

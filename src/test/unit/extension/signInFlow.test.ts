import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { configFilePath, SignInFlow, type SignInBanner } from "../../../extension/signInFlow.js";

// The flow with a stand-in terminal, a CLI lookup the test finishes, and throwaway files.
// No CLI runs and nothing signs in.
describe("SignInFlow", () => {
  const HOST = "https://flow-unit.example.invalid";
  const window = vscode.window as unknown as Record<string, unknown>;
  let dir: string;
  let bundle: string;
  let config: string;
  let typed: string[];
  let banners: Array<SignInBanner | undefined>;
  let settingProfile: string | undefined;
  let finishCliLookup: (file: string | undefined) => void;
  let cliLookup: Promise<string | undefined>;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "bdi-signin-flow-"));
    bundle = path.join(dir, "bundle");
    config = path.join(dir, "databrickscfg");
    mkdirSync(bundle);
    writeFileSync(path.join(bundle, "databricks.yml"), `bundle:\n  name: b\ntargets:\n  dev:\n    workspace:\n      host: ${HOST}\n`);
    writeFileSync(config, "");
    for (const key of ["DATABRICKS_CONFIG_FILE", "DATABRICKS_CONFIG_PROFILE"]) saved[key] = process.env[key];
    process.env.DATABRICKS_CONFIG_FILE = config;
    delete process.env.DATABRICKS_CONFIG_PROFILE;
    typed = [];
    banners = [];
    settingProfile = undefined;
    cliLookup = new Promise((resolve) => (finishCliLookup = resolve));
    window.createTerminal = () => ({ show: () => {}, sendText: (text: string) => typed.push(text), dispose: () => {} });
    window.showInputBox = async () => undefined;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const flow = () => {
    const signIn = new SignInFlow({
      bundleFiles: () => [path.join(bundle, "databricks.yml")],
      configuredProfile: () => settingProfile,
      cliFile: () => cliLookup,
      changed: (_root, banner) => banners.push(banner),
      telemetry: () => {},
    });
    signIn.bannerFor(bundle, "dev", "not_logged_in");
    return signIn;
  };

  test("a token profile saved while the CLI is looked up is not replaced", async () => {
    settingProfile = "protected";
    const signIn = flow();
    const opening = signIn.openTerminal(bundle, "dev", "graph");
    writeFileSync(config, `[protected]\nhost = ${HOST}\ntoken = fake-test-only\n`);
    finishCliLookup(undefined);
    await opening;
    expect(typed).toEqual([]);
    expect(signIn.bannerOf(bundle)?.blockedReason).toMatch(/signs in another way/);
    signIn.dispose();
  });

  test("Check again clicked while the CLI is looked up opens no terminal", async () => {
    const signIn = flow();
    const opening = signIn.openTerminal(bundle, "dev", "graph");
    signIn.markChecking(bundle, "dev");
    finishCliLookup(undefined);
    await opening;
    expect(typed).toEqual([]);
    expect(signIn.bannerOf(bundle)?.stage).toBe("checking");
    signIn.dispose();
  });

  test("DATABRICKS_CONFIG_PROFILE is the profile signed in, before the bundle's, as the CLI picks it", async () => {
    process.env.DATABRICKS_CONFIG_PROFILE = "env-picked";
    const signIn = flow();
    expect(signIn.bannerOf(bundle)?.signsInAs).toEqual({ profile: "env-picked", source: "environment" });
    finishCliLookup(undefined);
    await signIn.openTerminal(bundle, "dev", "graph");
    expect(typed).toEqual([`databricks auth login --host "${HOST}" --profile "env-picked"`]);
    // Once the terminal is open, the command there says it.
    expect(signIn.bannerOf(bundle)?.signsInAs).toBeUndefined();
    signIn.dispose();
  });

  test("the profile setting still comes before DATABRICKS_CONFIG_PROFILE, as --profile does", async () => {
    process.env.DATABRICKS_CONFIG_PROFILE = "env-picked";
    settingProfile = "from-settings";
    const signIn = flow();
    expect(signIn.bannerOf(bundle)?.signsInAs).toEqual({ profile: "from-settings", source: "setting" });
    finishCliLookup(undefined);
    await signIn.openTerminal(bundle, "dev", "graph");
    expect(typed).toEqual([`databricks auth login --host "${HOST}" --profile "from-settings"`]);
    signIn.dispose();
  });

  test("the banner names the profile the terminal then gets, and says where it comes from", async () => {
    const cases: Array<{ yaml: string; config?: string; profile: string; source: string }> = [
      { yaml: `    workspace:\n      host: ${HOST}\n`, profile: "flow-unit", source: "new" },
      { yaml: `    workspace:\n      host: ${HOST}\n`, config: `[mine]\nhost = ${HOST}\nauth_type = databricks-cli\n`, profile: "mine", source: "existing" },
      { yaml: `    workspace:\n      host: ${HOST}\n      profile: from-bundle\n`, profile: "from-bundle", source: "bundle" },
      { yaml: "    default: true\n", profile: "DEFAULT", source: "default" },
    ];
    window.showInputBox = async () => HOST;
    for (const { yaml, config: text = "", profile, source } of cases) {
      writeFileSync(path.join(bundle, "databricks.yml"), `bundle:\n  name: b\ntargets:\n  dev:\n${yaml}`);
      writeFileSync(config, text);
      typed = [];
      const signIn = flow();
      expect(signIn.bannerOf(bundle)?.signsInAs).toEqual({ profile, source });
      finishCliLookup(undefined);
      await signIn.openTerminal(bundle, "dev", "graph");
      expect(typed).toEqual([`databricks auth login --host "${HOST}" --profile "${profile}"`]);
      signIn.dispose();
    }
  });

  test("no name on a banner that can't offer the sign-in", () => {
    settingProfile = "protected";
    writeFileSync(config, `[protected]\nhost = ${HOST}\ntoken = fake-test-only\n`);
    const signIn = flow();
    expect(signIn.bannerOf(bundle)?.blockedReason).toMatch(/signs in another way/);
    expect(signIn.bannerOf(bundle)?.signsInAs).toBeUndefined();
    signIn.dispose();
  });

  test("a relative DATABRICKS_CONFIG_FILE is read from the bundle's folder, where the CLI runs", async () => {
    writeFileSync(path.join(bundle, "relative.cfg"), `[protected]\nhost = ${HOST}\ntoken = fake-test-only\n`);
    process.env.DATABRICKS_CONFIG_FILE = "relative.cfg";
    settingProfile = "protected";
    const signIn = flow();
    finishCliLookup(undefined);
    await signIn.openTerminal(bundle, "dev", "graph");
    expect(typed).toEqual([]);
    expect(signIn.bannerOf(bundle)?.blockedReason).toMatch(/signs in another way/);
    signIn.dispose();
  });
});

describe("configFilePath", () => {
  const home = os.homedir();
  test("unset is ~/.databrickscfg; ~/ is the home folder; relative is from the folder given; absolute as it is", () => {
    expect(configFilePath("/bundle", {})).toBe(path.join(home, ".databrickscfg"));
    expect(configFilePath("/bundle", { DATABRICKS_CONFIG_FILE: "~/x.cfg" })).toBe(path.join(home, "x.cfg"));
    expect(configFilePath("/bundle", { DATABRICKS_CONFIG_FILE: "conf/x.cfg" })).toBe(path.resolve("/bundle", "conf/x.cfg"));
    expect(configFilePath("/bundle", { DATABRICKS_CONFIG_FILE: "/etc/x.cfg" })).toBe(path.resolve("/etc/x.cfg"));
  });
});

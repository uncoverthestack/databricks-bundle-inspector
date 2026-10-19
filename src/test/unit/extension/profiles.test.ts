import { describe, test, expect } from "@jest/globals";
import {
  parseAmbiguousProfiles,
  parseProfileList,
  profilesForHost,
} from "../../../databricksCli/profiles.js";

// Messages as printed by `bundle validate -t <target>` when two profiles in the config
// file point at the target's host (checked on CLI 0.299.0 and 1.21.0).
const CLI_1_21 =
  "cannot resolve bundle auth configuration: resolve: https://example-ambig.cloud.databricks.com: multiple profiles matched: first-one, second one: please set DATABRICKS_CONFIG_PROFILE or provide --profile flag to specify one. Config: host=https://example-ambig.cloud.databricks.com, config_file=/tmp/ambig.cfg. Env: DATABRICKS_CONFIG_FILE";
const CLI_0_299 =
  "cannot resolve bundle auth configuration: resolve: https://example-ambig.cloud.databricks.com: multiple profiles matched: first-one, second one: please set DATABRICKS_CONFIG_PROFILE or provide --profile flag to specify one. Config: host=https://example-ambig.cloud.databricks.com, config_file=/tmp/ambig.cfg, databricks_cli_path=/opt/databricks. Env: DATABRICKS_CONFIG_FILE, DATABRICKS_CLI_PATH";

describe("parseAmbiguousProfiles", () => {
  test.each([["CLI 1.21.0", CLI_1_21], ["CLI 0.299.0", CLI_0_299]])("reads the workspace and the profiles (%s)", (_, message) => {
    expect(parseAmbiguousProfiles(message)).toEqual({
      host: "https://example-ambig.cloud.databricks.com",
      names: ["first-one", "second one"],
    });
  });

  test("ignores other errors, including other profile errors", () => {
    expect(parseAmbiguousProfiles("notebook src/x.py not found")).toBeUndefined();
    expect(
      parseAmbiguousProfiles(
        "cannot resolve bundle auth configuration: resolve: /home/u/.databrickscfg has no NOPE profile configured",
      ),
    ).toBeUndefined();
  });
});

describe("parseProfileList", () => {
  test("reads `databricks auth profiles --skip-validate -o json`", () => {
    const json = JSON.stringify({
      profiles: [
        { name: "DEFAULT", host: "https://a.cloud.databricks.com", auth_type: "pat", valid: false, default: true, account_id: "", cloud: "aws", workspace_id: "" },
        { name: "second one", host: "https://a.cloud.databricks.com/", auth_type: "databricks-cli" },
        { host: "https://no-name" },
      ],
    });
    expect(parseProfileList(json)).toEqual([
      { name: "DEFAULT", host: "https://a.cloud.databricks.com", authType: "pat" },
      { name: "second one", host: "https://a.cloud.databricks.com/", authType: "databricks-cli" },
    ]);
  });

  test("returns nothing for output it can't read", () => {
    expect(parseProfileList("not json")).toEqual([]);
    expect(parseProfileList("{}")).toEqual([]);
  });
});

describe("profilesForHost", () => {
  test("matches the workspace regardless of a trailing slash or letter case", () => {
    const profiles = [
      { name: "a", host: "https://A.cloud.databricks.com/" },
      { name: "b", host: "https://a.cloud.databricks.com" },
      { name: "other", host: "https://b.cloud.databricks.com" },
      { name: "no-host" },
    ];
    expect(profilesForHost(profiles, "https://a.cloud.databricks.com").map((p) => p.name)).toEqual(["a", "b"]);
  });
});

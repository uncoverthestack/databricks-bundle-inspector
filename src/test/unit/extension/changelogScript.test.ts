import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// scripts/changelog.mjs, run as the release runs it, on a scratch copy.
const SCRIPT = path.resolve("scripts/changelog.mjs");

describe("scripts/changelog.mjs", () => {
  let root: string;
  const run = (command: string) => spawnSync(process.execPath, [SCRIPT, command, "--root", root], { encoding: "utf8" });
  const changelog = () => readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const change = (name: string, text: string) => writeFileSync(path.join(root, "changes", name), text);

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "bdi-changelog-"));
    mkdirSync(path.join(root, "changes"));
    writeFileSync(path.join(root, "changes", "README.md"), "# Not a change\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const BASE = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- **Older added.**",
    "",
    "### Fixed",
    "",
    "- **Older fixed.**",
    "",
    "## [0.5.0] - 2026-10-23",
    "",
    "### Added",
    "",
    "- **Released.**",
    "",
  ].join("\n");

  test("each change goes to the top of its section, newest issue first, and the files are deleted", () => {
    writeFileSync(path.join(root, "CHANGELOG.md"), BASE);
    change("269-why.md", "Added\n\n- **Says why.**\n");
    change("1000-later.md", "### Added\n\n- **Later issue.**\n");
    change("265-lists.md", "Fixed\n\n- **Lists from variables.**\n- **Second item.**\n");
    expect(run("check").status).toBe(0);
    const release = run("release");
    expect(release.status).toBe(0);
    expect(release.stdout).toContain("Moved 3 change files");
    expect(changelog()).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "",
        "- **Later issue.**",
        "- **Says why.**",
        "- **Older added.**",
        "",
        "### Fixed",
        "",
        "- **Lists from variables.**",
        "- **Second item.**",
        "- **Older fixed.**",
        "",
        "## [0.5.0] - 2026-10-23",
        "",
        "### Added",
        "",
        "- **Released.**",
        "",
      ].join("\n"),
    );
    expect(readdirSync(path.join(root, "changes"))).toEqual(["README.md"]);
  });

  test("a section [Unreleased] doesn't have yet is added in Keep a Changelog's order", () => {
    writeFileSync(path.join(root, "CHANGELOG.md"), BASE);
    change("270-changed.md", "Changed\n\n- **Changed thing.**\n");
    change("271-security.md", "Security\n\n- **Security thing.**\n");
    expect(run("release").status).toBe(0);
    expect(changelog()).toContain(
      "- **Older added.**\n\n### Changed\n\n- **Changed thing.**\n\n### Fixed\n\n- **Older fixed.**\n\n### Security\n\n- **Security thing.**\n\n## [0.5.0]",
    );
  });

  test("an empty [Unreleased], as right after a release, gets its sections and keeps one blank line before the version", () => {
    writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.5.0] - 2026-10-23\n\n- **Released.**\n");
    change("272-fix.md", "Fixed\n\n- **A fix.**\n");
    expect(run("release").status).toBe(0);
    expect(changelog()).toBe("# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- **A fix.**\n\n## [0.5.0] - 2026-10-23\n\n- **Released.**\n");
  });

  test("a malformed file fails check and release, names the file, and changes nothing", () => {
    writeFileSync(path.join(root, "CHANGELOG.md"), BASE);
    change("273-ok.md", "Added\n\n- **Fine.**\n");
    const cases: Array<[string, string]> = [
      ["Fixes\n\n- **Typo in the section.**\n", 'the first line must be one of Added, Changed, Deprecated, Removed, Fixed, Security, not "Fixes"'],
      ["Fixed\n\nNo list item.\n", 'needs an entry starting with "- " after the Fixed line'],
      ["", 'the first line must be one of Added, Changed, Deprecated, Removed, Fixed, Security, not ""'],
    ];
    for (const [text, message] of cases) {
      change("274-bad.md", text);
      for (const command of ["check", "release"]) {
        const result = run(command);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`274-bad.md: ${message}`);
      }
      expect(changelog()).toBe(BASE);
      expect(existsSync(path.join(root, "changes", "273-ok.md"))).toBe(true);
    }
  });

  test("Windows line endings in a change file are read as the same entry", () => {
    writeFileSync(path.join(root, "CHANGELOG.md"), BASE);
    change("275-crlf.md", "Fixed\r\n\r\n- **From Windows.**\r\n");
    expect(run("release").status).toBe(0);
    expect(changelog()).toContain("### Fixed\n\n- **From Windows.**\n- **Older fixed.**\n");
    expect(changelog()).not.toContain("\r");
  });

  test("on the repository's own CHANGELOG: no files change nothing, and one file adds exactly its line", () => {
    const real = readFileSync(path.resolve("CHANGELOG.md"), "utf8");
    writeFileSync(path.join(root, "CHANGELOG.md"), real);
    expect(run("release").status).toBe(0);
    expect(changelog()).toBe(real);

    change("276-one.md", "Fixed\n\n- **One more fix.**\n");
    expect(run("release").status).toBe(0);
    const added = changelog().split("\n");
    const before = real.split("\n");
    expect(added.length).toBe(before.length + 1);
    const at = added.indexOf("- **One more fix.**");
    expect(added.slice(at - 2, at)).toEqual(["### Fixed", ""]);
    expect([...added.slice(0, at), ...added.slice(at + 1)]).toEqual(before);
  });

  test("an unknown command, or a CHANGELOG with no [Unreleased], is refused", () => {
    expect(run("publish").status).toBe(2);
    writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [0.5.0]\n");
    change("277-x.md", "Added\n\n- **X.**\n");
    const result = run("release");
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("CHANGELOG.md has no ## [Unreleased] heading");
    expect(existsSync(path.join(root, "changes", "277-x.md"))).toBe(true);
  });
});

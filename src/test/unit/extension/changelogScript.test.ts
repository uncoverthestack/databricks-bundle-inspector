import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("a CHANGELOG with Windows line endings keeps them, as git on Windows checks it out", () => {
    const crlf = BASE.replace(/\n/g, "\r\n");
    writeFileSync(path.join(root, "CHANGELOG.md"), crlf);
    expect(run("release").status).toBe(0);
    expect(changelog()).toBe(crlf);
    change("279-win.md", "Fixed\n\n- **On Windows.**\n");
    expect(run("release").status).toBe(0);
    expect(changelog()).toBe(crlf.replace("### Fixed\r\n\r\n", "### Fixed\r\n\r\n- **On Windows.**\r\n"));
  });

  test("on the repository's own CHANGELOG: no files change nothing, and one file changes only [Unreleased]", () => {
    const real = readFileSync(path.resolve("CHANGELOG.md"), "utf8");
    writeFileSync(path.join(root, "CHANGELOG.md"), real);
    expect(run("release").status).toBe(0);
    expect(changelog()).toBe(real);

    change("276-one.md", "Fixed\n\n- **One more fix.**\n");
    expect(run("release").status).toBe(0);
    const added = changelog().split(/\r?\n/);
    const before = real.split(/\r?\n/);
    const at = added.indexOf("- **One more fix.**");
    expect(added.slice(at - 2, at)).toEqual(["### Fixed", ""]);
    // Right after a release [Unreleased] is empty and gains a Fixed heading too, so lines aren't counted.
    const unreleased = (lines: string[]) => {
      const start = lines.indexOf("## [Unreleased]");
      const end = lines.findIndex((line, i) => i > start && line.startsWith("## ["));
      return { head: lines.slice(0, start + 1), released: lines.slice(end), at: [start, end] };
    };
    const after = unreleased(added);
    expect(after.head).toEqual(unreleased(before).head);
    expect(after.released).toEqual(unreleased(before).released);
    expect(at).toBeGreaterThan(after.at[0]!);
    expect(at).toBeLessThan(after.at[1]!);
  });

  // It once compared the paths without resolving links, and then did nothing at all, so a
  // check from a linked folder (macOS's /var is /private/var) passed without checking.
  (process.platform === "win32" ? test.skip : test)("runs when reached through a linked folder", () => {
    writeFileSync(path.join(root, "CHANGELOG.md"), BASE);
    change("278-bad.md", "Fixes\n\n- **Wrong section.**\n");
    const link = path.join(root, "linked-scripts");
    symlinkSync(path.dirname(SCRIPT), link);
    const result = spawnSync(process.execPath, [path.join(link, "changelog.mjs"), "check", "--root", root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("278-bad.md");
  });

  describe("notes: one version's section, for its GitHub release (#294)", () => {
    const notes = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, "notes", ...args, "--root", root], { encoding: "utf8" });
    const VERSIONS = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "",
      "- **Not released yet.**",
      "",
      "## [10.6.0] - 2026-12-01",
      "",
      "- **Ten.**",
      "",
      "## [0.6.0-beta] - 2026-10-28",
      "",
      "- **Beta.**",
      "",
      "## [0.6.0] - 2026-10-29",
      "",
      "### Added",
      "",
      "- **Six.**",
      "",
      "### Fixed",
      "",
      "- **Six fixed.**",
      "",
      "## [0.5.0]",
      "",
      "- **Five, no date.**",
      "",
      "### Compatibility",
      "",
      "- VS Code `^1.85.0`.",
      "",
      "[0.6.0]: https://github.com/uncoverthestack/databricks-bundle-inspector/compare/v0.5.0...v0.6.0",
      "",
    ].join("\n");

    test("gives only that version, from the newest to the oldest, which stops before the compare links", () => {
      writeFileSync(path.join(root, "CHANGELOG.md"), VERSIONS);
      const cases: Array<[string, string]> = [
        ["10.6.0", "- **Ten.**"],
        ["0.6.0-beta", "- **Beta.**"],
        ["0.6.0", "### Added\n\n- **Six.**\n\n### Fixed\n\n- **Six fixed.**"],
        ["0.5.0", "- **Five, no date.**\n\n### Compatibility\n\n- VS Code `^1.85.0`."],
      ];
      for (const [version, expected] of cases) {
        const result = notes(version);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(`${expected}\n`);
      }
    });

    test("a version with no heading, a part of one, or an empty section fails, with nothing printed", () => {
      writeFileSync(path.join(root, "CHANGELOG.md"), VERSIONS.replace("- **Ten.**\n", ""));
      const cases: Array<[string, string]> = [
        ["0.7.0", "CHANGELOG.md has no ## [0.7.0] heading"],
        ["0.6", "CHANGELOG.md has no ## [0.6] heading"],
        ["6.0", "CHANGELOG.md has no ## [6.0] heading"],
        ["10.6.0", "CHANGELOG.md has nothing under ## [10.6.0]"],
      ];
      for (const [version, message] of cases) {
        const result = notes(version);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim()).toBe(message);
      }
      expect(notes().status).toBe(2);
    });

    test("a CHANGELOG with Windows line endings gives the same notes", () => {
      writeFileSync(path.join(root, "CHANGELOG.md"), VERSIONS.replace(/\n/g, "\r\n"));
      expect(notes("0.6.0").stdout).toBe("### Added\n\n- **Six.**\n\n### Fixed\n\n- **Six fixed.**\n");
    });

    test("on the repository's own CHANGELOG: every version has notes, and none holds another version or a compare link", () => {
      const real = readFileSync(path.resolve("CHANGELOG.md"), "utf8");
      writeFileSync(path.join(root, "CHANGELOG.md"), real);
      const versions = [...real.matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)].map((match) => match[1]!);
      expect(versions.length).toBeGreaterThan(10);
      for (const version of versions) {
        const result = notes(version);
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).not.toBe("");
        expect(result.stdout).not.toMatch(/^## \[/m);
        expect(result.stdout).not.toMatch(/^\[[^\]]+\]: /m);
      }
    });
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

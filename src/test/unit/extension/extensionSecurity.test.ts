import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isOpenFilePathAllowed } from "../../../extension.js";

describe("isOpenFilePathAllowed", () => {
  test("allows files under the active bundle directory", () => {
    expect(
      isOpenFilePathAllowed(
        "/workspace/project/resources/job.yml",
        "/workspace/project",
        undefined,
      ),
    ).toBe(true);
  });

  test("rejects similarly prefixed sibling directories", () => {
    expect(
      isOpenFilePathAllowed(
        "/workspace/project-secrets/databrickscfg",
        "/workspace/project",
        undefined,
      ),
    ).toBe(false);
  });

  test("allows files under an open workspace folder", () => {
    expect(
      isOpenFilePathAllowed("/workspace/shared/file.py", undefined, [
        { uri: { fsPath: "/workspace/shared" } },
      ]),
    ).toBe(true);
  });

  test("rejects relative paths", () => {
    expect(
      isOpenFilePathAllowed(
        "resources/job.yml",
        "/workspace/project",
        [{ uri: { fsPath: "/workspace/project" } }],
      ),
    ).toBe(false);
  });
});

// #326: a symlink inside the workspace can point anywhere. Real folders and links; Windows
// needs extra rights to create symlinks, so it skips these.
(process.platform === "win32" ? describe.skip : describe)("isOpenFilePathAllowed with symlinks", () => {
  let base: string;
  let workspace: string;
  beforeAll(() => {
    // Under os.tmpdir(), which on macOS is a link itself (/var is /private/var).
    base = mkdtempSync(path.join(os.tmpdir(), "open-file-"));
    workspace = path.join(base, "workspace");
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(workspace, "src", "load.py"), "print(1)\n");
    writeFileSync(path.join(base, "outside", "credentials"), "secret\n");
    symlinkSync(path.join(base, "outside", "credentials"), path.join(workspace, "src", "notes.py"));
    symlinkSync(path.join(workspace, "src", "load.py"), path.join(workspace, "src", "alias.py"));
    symlinkSync(path.join(base, "outside"), path.join(workspace, "linked-dir"));
    symlinkSync(path.join(base, "missing-target"), path.join(workspace, "src", "dangling.py"));
    symlinkSync(workspace, path.join(base, "workspace-link"));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const folders = () => [{ uri: { fsPath: workspace } }];

  test("opens a normal file in the workspace", () => {
    expect(isOpenFilePathAllowed(path.join(workspace, "src", "load.py"), undefined, folders())).toBe(true);
  });

  test("refuses a symlinked file that leads out of the workspace", () => {
    expect(isOpenFilePathAllowed(path.join(workspace, "src", "notes.py"), workspace, folders())).toBe(false);
  });

  test("refuses a file under a symlinked folder that leads out of the workspace", () => {
    expect(isOpenFilePathAllowed(path.join(workspace, "linked-dir", "credentials"), workspace, folders())).toBe(false);
  });

  test("opens a symlink whose target is inside the workspace", () => {
    expect(isOpenFilePathAllowed(path.join(workspace, "src", "alias.py"), undefined, folders())).toBe(true);
  });

  test("opens a file in a workspace opened through a link to it", () => {
    const viaLink = path.join(base, "workspace-link");
    expect(isOpenFilePathAllowed(path.join(viaLink, "src", "load.py"), undefined, [{ uri: { fsPath: viaLink } }])).toBe(true);
  });

  test("decides a missing file, or a broken link, by its path as written", () => {
    expect(isOpenFilePathAllowed(path.join(workspace, "src", "not-there.py"), undefined, folders())).toBe(true);
    expect(isOpenFilePathAllowed(path.join(workspace, "src", "dangling.py"), undefined, folders())).toBe(true);
    expect(isOpenFilePathAllowed(path.join(base, "outside", "credentials"), undefined, folders())).toBe(false);
  });
});

// The forms a Windows path can take must not stop an ordinary file opening, and a
// directory junction (any user can make one) must be followed like a symlink (#326).
(process.platform === "win32" ? describe : describe.skip)("isOpenFilePathAllowed on Windows", () => {
  let base: string;
  let workspace: string;
  let file: string;
  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "open-file-win-")));
    workspace = path.join(base, "workspace");
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    mkdirSync(path.join(base, "outside"));
    file = path.join(workspace, "src", "load.py");
    writeFileSync(file, "print(1)\n");
    writeFileSync(path.join(base, "outside", "credentials"), "secret\n");
    symlinkSync(path.join(base, "outside"), path.join(workspace, "linked-out"), "junction");
    symlinkSync(path.join(workspace, "src"), path.join(workspace, "linked-in"), "junction");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const folders = () => [{ uri: { fsPath: workspace } }];
  const lowerDrive = (p: string) => p.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());

  test("opens an ordinary file", () => {
    expect(isOpenFilePathAllowed(file, workspace, folders())).toBe(true);
  });

  test("opens it with a lowercase drive letter, as VS Code writes workspace folders", () => {
    expect(isOpenFilePathAllowed(lowerDrive(file), undefined, [{ uri: { fsPath: lowerDrive(workspace) } }])).toBe(true);
    expect(isOpenFilePathAllowed(file, undefined, [{ uri: { fsPath: lowerDrive(workspace) } }])).toBe(true);
  });

  test("opens it through the short 8.3 form of the folder, when Windows has one", () => {
    const short = execFileSync("cmd", ["/c", `for %A in ("${workspace}") do @echo %~sA`], { encoding: "utf8" }).trim();
    expect(isOpenFilePathAllowed(path.join(short, "src", "load.py"), undefined, [{ uri: { fsPath: short } }])).toBe(true);
    // TEMPORARY diagnostic, to be removed.
    const show = (p: string) => { try { return JSON.stringify({ native: realpathSync.native(p), js: realpathSync(p) }); } catch (e) { return String(e); } };
    console.log(`DIAG tmpdir=${os.tmpdir()} short=${short} file=${file}\nDIAG realpath(short)=${show(short)}\nDIAG realpath(file)=${show(file)}\nDIAG realpath(shortfile)=${show(path.join(short, "src", "load.py"))}`);
    expect(isOpenFilePathAllowed(file, undefined, [{ uri: { fsPath: short } }])).toBe(true);
  });

  test("refuses a file through a junction that leads out of the workspace", () => {
    expect(isOpenFilePathAllowed(path.join(workspace, "linked-out", "credentials"), workspace, folders())).toBe(false);
  });

  test("opens a file through a junction that stays in the workspace", () => {
    expect(isOpenFilePathAllowed(path.join(workspace, "linked-in", "load.py"), workspace, folders())).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

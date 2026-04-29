import { describe, expect, test } from "@jest/globals";
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

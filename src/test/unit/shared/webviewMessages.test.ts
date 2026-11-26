import { describe, expect, test } from "@jest/globals";
import { isWebviewMessage } from "../../../shared/webviewMessages.js";

// Messages from the webview are data from another process: only the type is trusted here,
// each field is still checked where it is used (extension.ts).
describe("isWebviewMessage", () => {
  test("matches a message of the given type", () => {
    expect(isWebviewMessage({ type: "openFile", path: "/b/a.py" }, "openFile")).toBe(true);
    expect(isWebviewMessage({ type: "webviewReady" }, "webviewReady")).toBe(true);
  });

  test.each([
    ["another type", { type: "selectTarget", target: "dev" }],
    ["no type", { path: "/b/a.py" }],
    ["null", null],
    ["a string", "openFile"],
    ["undefined", undefined],
  ])("rejects %s", (_case, message) => {
    expect(isWebviewMessage(message, "openFile")).toBe(false);
  });

  test("leaves the fields unchecked", () => {
    const message: unknown = { type: "openFile", path: 42 };
    if (!isWebviewMessage(message, "openFile")) throw new Error("expected a match");
    // Typed `unknown`: the handler must check it before use.
    expect(typeof message.path).toBe("number");
  });
});

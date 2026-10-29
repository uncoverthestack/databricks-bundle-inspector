import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";

const manifest = JSON.parse(readFileSync(path.join(__dirname, "../../../../package.json"), "utf8")) as {
  type?: string;
  engines: { vscode: string };
  devDependencies: Record<string, string>;
};

/** The oldest VS Code a `^x.y.z` range allows, as [major, minor]. */
function oldest(range: string): [number, number] {
  const match = /^\^(\d+)\.(\d+)\.\d+$/.exec(range);
  if (!match) throw new Error(`expected a ^x.y.z range, not "${range}"`);
  return [Number(match[1]), Number(match[2])];
}

describe("the VS Code versions the extension says it supports (#307)", () => {
  test("an ESM extension asks for VS Code 1.100 or newer, the first that can load it", () => {
    // VS Code 1.99 fails to start it: "require() of ES Module ... not supported".
    if (manifest.type !== "module") return;
    const [major, minor] = oldest(manifest.engines.vscode);
    expect(major > 1 || minor >= 100).toBe(true);
  });

  test("@types/vscode is the oldest supported VS Code, so the type check refuses newer APIs", () => {
    const [major, minor] = oldest(manifest.engines.vscode);
    expect(manifest.devDependencies["@types/vscode"]).toBe(`${major}.${minor}.0`);
  });
});

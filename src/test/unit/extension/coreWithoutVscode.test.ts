import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The command-line tool (#348) runs the core from plain Node, where there is no `vscode`
// module. Code that needs VS Code lives in src/extension/ and src/extension.ts.
const CORE_FOLDERS = ["bundle", "databricksCli"];
const SRC = path.resolve(__dirname, "../../..");

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

describe("the core runs without VS Code (#348)", () => {
  test.each(CORE_FOLDERS)("nothing in src/%s imports vscode", (folder) => {
    const files = sourceFiles(path.join(SRC, folder));
    expect(files.length).toBeGreaterThan(0);
    const importsVscode = files.filter((file) =>
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']vscode["']/.test(readFileSync(file, "utf8")),
    );
    expect(importsVscode.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});

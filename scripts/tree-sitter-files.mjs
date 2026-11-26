// The Python parser's files (#649), copied next to each bundle into a `tree-sitter` folder,
// where src/bundle/code/pythonParser.ts loads them. Its TREE_SITTER_FILES must match this list
// (a unit test checks).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** File name in the folder, and where it comes from. */
export const TREE_SITTER_FILES = {
  "tree-sitter.cjs": "web-tree-sitter",
  "tree-sitter.wasm": "web-tree-sitter/tree-sitter.wasm",
  "tree-sitter-python.wasm": "tree-sitter-python/tree-sitter-python.wasm",
};

/** Each licence the copied files come under. */
export function treeSitterLicences() {
  // Up from the package's main file: web-tree-sitter's exports don't list its package.json.
  const packageDir = (name) => {
    for (let dir = path.dirname(require.resolve(name)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      try {
        if (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name === name) return dir;
      } catch {
        // No package.json here; keep going up.
      }
    }
    throw new Error(`No package.json found for ${name}`);
  };
  const version = (name) => JSON.parse(readFileSync(path.join(packageDir(name), "package.json"), "utf8")).version;
  return [
    { name: "web-tree-sitter", version: version("web-tree-sitter"), license: "MIT", text: readFileSync(path.join(packageDir("web-tree-sitter"), "LICENSE"), "utf8").trim() },
    { name: "tree-sitter-python", version: version("tree-sitter-python"), license: "MIT", text: readFileSync(path.join(packageDir("tree-sitter-python"), "LICENSE"), "utf8").trim() },
  ];
}

/** Copies the files and their licences into `<bundleDir>/tree-sitter`. */
export function copyTreeSitterFiles(bundleDir) {
  const folder = path.join(bundleDir, "tree-sitter");
  mkdirSync(folder, { recursive: true });
  for (const [file, request] of Object.entries(TREE_SITTER_FILES)) {
    copyFileSync(require.resolve(request), path.join(folder, file));
  }
  writeFileSync(
    path.join(folder, "THIRD_PARTY_NOTICES.md"),
    [
      "# Third-party notices",
      "",
      "The files in this folder read Python code. They come from these packages.",
      ...treeSitterLicences().flatMap((entry) => ["", `## ${entry.name} ${entry.version} (${entry.license})`, "", "```", entry.text, "```"]),
      "",
    ].join("\n"),
  );
  return folder;
}

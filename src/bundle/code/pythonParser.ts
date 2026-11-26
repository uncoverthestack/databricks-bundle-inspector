/**
 * Python syntax trees from tree-sitter (#649): the `web-tree-sitter` runtime with the
 * WebAssembly grammar the official `tree-sitter-python` package ships (0.25.0, built for
 * tree-sitter 0.25, the runtime's version). Both run as WebAssembly, so code is read the
 * same way on every OS, in the extension and in the command-line tool. It only reads text: nothing in the file is run.
 *
 * Neither package is bundled. Their three files are copied next to each bundle
 * (`dist/tree-sitter/` for the extension, `cli/dist/tree-sitter/` for the CLI) and loaded
 * from there at run time; tests load them from `node_modules`.
 *
 * When the parser can't be loaded, {@link withPythonTree} throws, so the file's checks are
 * reported as failed (`file_scan_failed`), never as passed.
 */
import fs from "node:fs/promises";
import type * as TreeSitter from "web-tree-sitter";

export type SyntaxNode = TreeSitter.Node;

/** The files each bundle ships in its `tree-sitter` folder, and the package each comes from. */
export const TREE_SITTER_FILES = {
  "tree-sitter.cjs": "web-tree-sitter",
  "tree-sitter.wasm": "web-tree-sitter/tree-sitter.wasm",
  "tree-sitter-python.wasm": "tree-sitter-python/tree-sitter-python.wasm",
} as const;

type TreeSitterFile = keyof typeof TREE_SITTER_FILES;

interface LoadedParser {
  parser: TreeSitter.Parser;
}

let loading: Promise<LoadedParser> | undefined;

/**
 * Where a file is: next to the bundle first, then in its npm package. `require` is
 * CommonJS's in the CLI and in tests, and the one the extension bundle's banner makes from
 * its own file, so `./tree-sitter/...` is found next to whichever bundle runs.
 */
function treeSitterFile(file: TreeSitterFile): string {
  for (const request of [`./tree-sitter/${file}`, TREE_SITTER_FILES[file]]) {
    try {
      return require.resolve(request);
    } catch {
      // Try the next place.
    }
  }
  throw new Error(`The Python parser's file ${file} was not found.`);
}

async function load(): Promise<LoadedParser> {
  const module = require(treeSitterFile("tree-sitter.cjs")) as typeof TreeSitter;
  const runtime = treeSitterFile("tree-sitter.wasm");
  await module.Parser.init({ locateFile: () => runtime });
  // Bytes, not a path: given a path, the runtime loads `fs` with import(), which Jest can't run.
  const language = await module.Language.load(new Uint8Array(await fs.readFile(treeSitterFile("tree-sitter-python.wasm"))));
  const parser = new module.Parser();
  parser.setLanguage(language);
  return { parser };
}

function loaded(): Promise<LoadedParser> {
  loading ??= load().catch((error: unknown) => {
    // Tried again next time: a failed load is not kept.
    loading = undefined;
    throw error;
  });
  return loading;
}

/**
 * Parses `text` as Python and hands its root node to `read`. The tree lives in WebAssembly
 * memory, which JavaScript's garbage collector doesn't free, so it is deleted as soon as
 * `read` returns: `read` must not keep nodes.
 */
export async function withPythonTree<T>(text: string, read: (root: SyntaxNode) => T): Promise<T> {
  const { parser } = await loaded();
  const tree = parser.parse(text);
  if (!tree) throw new Error("The Python parser returned no tree.");
  try {
    return read(tree.rootNode);
  } finally {
    tree.delete();
  }
}

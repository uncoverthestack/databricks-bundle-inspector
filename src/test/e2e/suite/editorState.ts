import assert from "node:assert/strict";
import * as vscode from "vscode";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shows a file with the cursor on a line, and returns once the extension sees it as the
 * active editor. Use it before every Inspect that reads the cursor: Inspect brings the
 * graph to the front of the file, and VS Code tells the extension a moment later, so
 * moving the cursor of the hidden editor and inspecting again races that message
 * (an Inspect that loses finds no editor and does nothing).
 */
export async function showFileAt(document: vscode.TextDocument, line = 0): Promise<vscode.TextEditor> {
  const position = new vscode.Position(line, 0);
  const editor = await vscode.window.showTextDocument(document, {
    selection: new vscode.Range(position, position),
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const active = vscode.window.activeTextEditor;
    if (active?.document === document && active.selection.active.line === line) return editor;
    await sleep(50);
  }
  assert.fail(`${document.fileName} did not become the active editor at line ${line + 1}`);
}

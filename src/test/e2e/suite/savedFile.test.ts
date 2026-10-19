import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { codeValue } from "../../../bundle/issueDocs.js";

const ROUNDS = 3;
const BROKEN = 'key="rowcount"';
const FIXED = 'key="row_count"';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function databricksCliAvailable(): boolean {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Whether the inspector's task value warning is in the Problems panel. */
function warningShown(): boolean {
  return vscode.languages
    .getDiagnostics()
    .some(([, diagnostics]) => diagnostics.some((d) => codeValue(d.code)?.startsWith("task_value_")));
}

async function expectWarning(shown: boolean, after: string): Promise<void> {
  for (let waited = 0; warningShown() !== shown && waited < 10_000; waited += 250) await sleep(250);
  assert.equal(
    warningShown(),
    shown,
    `10 seconds after ${after}, the warning should be ${shown ? "back" : "gone"}`,
  );
  // Let the watcher's own event for this change pass before the next one.
  await sleep(700);
}

/**
 * A warning on a notebook has to follow the notebook: gone when it is fixed, back when
 * it is broken again, whether the change is saved in the editor or made outside it,
 * and without `databricks.yml` ever being saved. Run with
 * `npm run test:e2e:saved-file:other-case` to open the folder under another letter case.
 */
export function savedFileSuite() {
  describe("a warning follows its file (needs a real Databricks CLI)", function () {
    let consumer: string;
    /** The same file as the disk spells it, which is how a terminal or git would name it. */
    let consumerOnDisk: string;
    let original: string;

    before(async function () {
      if (!databricksCliAvailable()) this.skip();
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the saved-file fixture should be the open folder");
      consumer = path.join(root, "src", "consumer.py");
      consumerOnDisk = realpathSync.native(consumer);
      original = await readFile(consumer, "utf8");
      await expectWarning(true, "opening the folder");
    });

    after(async function () {
      if (original !== undefined) await writeFile(consumerOnDisk, original);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    async function saveInEditor(find: string, replacement: string): Promise<void> {
      const document = await vscode.workspace.openTextDocument(consumer);
      const editor = await vscode.window.showTextDocument(document);
      const start = document.getText().indexOf(find);
      assert.ok(start >= 0, `"${find}" should be in consumer.py`);
      await editor.edit((edit) =>
        edit.replace(
          new vscode.Range(document.positionAt(start), document.positionAt(start + find.length)),
          replacement,
        ),
      );
      await document.save();
    }

    async function writeOutsideEditor(find: string, replacement: string): Promise<void> {
      const text = await readFile(consumerOnDisk, "utf8");
      assert.ok(text.includes(find), `"${find}" should be in consumer.py`);
      await writeFile(consumerOnDisk, text.replace(find, replacement));
    }

    it(`clears and returns over ${ROUNDS} rounds, saved in the editor and changed outside it`, async function () {
      for (let round = 1; round <= ROUNDS; round++) {
        await saveInEditor(BROKEN, FIXED);
        await expectWarning(false, `round ${round}: fixing it in the editor`);
        await writeOutsideEditor(FIXED, BROKEN);
        await expectWarning(true, `round ${round}: breaking it outside the editor`);
        await writeOutsideEditor(BROKEN, FIXED);
        await expectWarning(false, `round ${round}: fixing it outside the editor`);
        await saveInEditor(FIXED, BROKEN);
        await expectWarning(true, `round ${round}: breaking it in the editor`);
      }
    });
  });
}

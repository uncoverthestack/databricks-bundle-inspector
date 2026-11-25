import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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

  describe("files the bundle never names (needs a real Databricks CLI)", function () {
    let root: string;

    before(function () {
      if (!databricksCliAvailable()) this.skip();
      root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      assert.ok(root, "the saved-file fixture should be the open folder");
    });

    after(async function () {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    /** Waits until the inspector's problem with `code` is shown or gone, then checks. */
    async function expectCode(code: string, shown: boolean, after: string): Promise<void> {
      const has = () =>
        vscode.languages.getDiagnostics().some(([, diagnostics]) => diagnostics.some((d) => codeValue(d.code) === code));
      for (let waited = 0; has() !== shown && waited < 10_000; waited += 250) await sleep(250);
      assert.equal(has(), shown, `10 seconds after ${after}, ${code} should be ${shown ? "shown" : "gone"}`);
      await sleep(700);
    }

    it("a warning in a %run notebook follows that notebook alone", async function () {
      const child = realpathSync.native(path.join(root, "src", "helpers", "child.py"));
      const original = await readFile(child, "utf8");
      try {
        await expectCode("widget_not_set", true, "opening the folder");
        await writeFile(child, original.replace('dbutils.widgets.get("child_setting")', '"fixed"'));
        await expectCode("widget_not_set", false, "fixing the %run notebook");
        await writeFile(child, original);
        await expectCode("widget_not_set", true, "breaking the %run notebook again");
      } finally {
        await writeFile(child, original);
      }
    });

    it("two new notebooks no task names, with one workspace path, are found and cleared", async function () {
      const header = "# Databricks notebook source\n";
      const python = path.join(root, "src", "orphan.py");
      const sql = path.join(root, "src", "orphan.sql");
      try {
        await expectCode("same_workspace_path", false, "opening the folder");
        await writeFile(python, header);
        await writeFile(sql, "-- Databricks notebook source\n");
        await expectCode("same_workspace_path", true, "creating orphan.py and orphan.sql");
        await rm(sql);
        await expectCode("same_workspace_path", false, "deleting orphan.sql");
      } finally {
        await rm(python, { force: true });
        await rm(sql, { force: true });
      }
    });

    it("a file created in a pipeline glob folder outside the bundle clears its finding (#590)", async function () {
      // An empty folder outside the bundle, which a new pipeline's glob points at.
      const outside = await mkdtemp(path.join(os.tmpdir(), "dbi-outside-"));
      const sources = path.join(outside, "sources");
      await mkdir(sources);
      const resources = path.join(root, "resources");
      const glob = path.relative(resources, sources).split(path.sep).join("/");
      const yaml = path.join(resources, "outside_pipeline.yml");
      // Another drive on Windows: no relative path, so nothing to check.
      if (path.isAbsolute(glob)) this.skip();
      try {
        await writeFile(yaml, `resources:\n  pipelines:\n    outside:\n      name: outside\n      libraries:\n        - glob:\n            include: ${glob}/**\n`);
        await expectCode("missing_pipeline_source", true, "adding a pipeline whose outside glob folder is empty");
        await writeFile(path.join(sources, "new.sql"), "CREATE OR REFRESH MATERIALIZED VIEW t AS SELECT 1;\n");
        await expectCode("missing_pipeline_source", false, "creating a file in that outside folder");
      } finally {
        await rm(yaml, { force: true });
        await rm(outside, { recursive: true, force: true });
      }
      await expectCode("missing_pipeline_source", false, "removing the pipeline");
    });
  });
}

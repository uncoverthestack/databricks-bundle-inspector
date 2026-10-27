import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import { codeValue } from "../../../bundle/issueDocs.js";

const ROUNDS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** Runs against a throwaway copy of the issue-codes fixture in the real extension host. */
export function issueCodesSuite() {
  describe("linked issue codes survive repeated checks and quick fixes", function () {
    this.timeout(120_000);
    let bundle: vscode.Uri;
    let resource: vscode.Uri;

    const diagnostics = () => vscode.languages.getDiagnostics().flatMap(([uri, items]) =>
      items.filter(item => item.source?.startsWith("Databricks Bundle"))
        .map(item => ({ uri, item })),
    );
    const finding = (uri: vscode.Uri, kind: string) => vscode.languages.getDiagnostics(uri)
      .find(item => codeValue(item.code) === kind);

    async function inspect(): Promise<void> {
      await vscode.window.showTextDocument(bundle);
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
      await waitFor(() => Boolean(finding(resource, "notebook_missing_extension")), "notebook finding");
    }

    function assertLinkedAndUnique(minimumFindings = 4): void {
      const keys = new Set<string>();
      const all = diagnostics();
      assert.ok(all.length >= minimumFindings, `at least ${minimumFindings} current findings should exist`);
      for (const { uri, item } of all) {
        assert.equal(typeof item.code, "object", `${item.message} must have a linked code`);
        if (typeof item.code !== "object") continue;
        const kind = codeValue(item.code);
        assert.ok(kind);
        assert.match(item.code.target.toString(), new RegExp(`/docs/checks\\.md#${kind}$`));
        const key = JSON.stringify([uri.toString(), item.range.start.line, item.range.start.character, item.message]);
        assert.ok(!keys.has(key), `duplicate Problems entry: ${item.message}`);
        keys.add(key);
      }
      for (const name of ["bogus_top_level", "bogus_job_field"]) {
        const matches = all.filter(({ item }) => item.message.includes(name));
        assert.equal(matches.length, 1, `${name} must appear once, including across CLI and inspector sources`);
        assert.equal(codeValue(matches[0]!.item.code), "unknown_or_deprecated_field");
      }
    }

    before(async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root);
      bundle = vscode.Uri.file(path.join(root, "databricks.yml"));
      resource = vscode.Uri.file(path.join(root, "resources/job.yml"));
      await inspect();
    });

    after(async function () {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    it("keeps CLI warnings single and every code linked over ten inspections", async function () {
      for (let round = 0; round < 10; round++) {
        await inspect();
        assertLinkedAndUnique();
      }
    });

    async function exerciseFix(uri: vscode.Uri, kind: string, oldValue: string, newValue: string): Promise<void> {
      const document = await vscode.workspace.openTextDocument(uri);
      const original = document.getText();
      const originalEol = document.eol;
      const originalBytes = await vscode.workspace.fs.readFile(uri);
      try {
        // Exercise Windows line endings through the actual editor, not just a text helper.
        const eolEdit = new vscode.WorkspaceEdit();
        eolEdit.set(uri, [vscode.TextEdit.setEndOfLine(vscode.EndOfLine.CRLF)]);
        await vscode.workspace.applyEdit(eolEdit);
        await document.save();
        for (let round = 0; round < ROUNDS; round++) {
          await waitFor(() => Boolean(finding(uri, kind)), `${kind} round ${round + 1}`);
          const diagnostic = finding(uri, kind)!;
          const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            "vscode.executeCodeActionProvider", uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value,
          );
          const fix = actions.find(action => action.title === `Change to "${newValue}"`);
          assert.ok(fix?.edit, `round ${round + 1}: linked diagnostic should still offer ${kind}`);
          assert.equal(fix.isPreferred, true);
          assert.ok(await vscode.workspace.applyEdit(fix.edit));
          if (fix.command) await vscode.commands.executeCommand(fix.command.command, ...(fix.command.arguments ?? []));
          assert.ok(document.getText().includes(newValue));
          await document.save();
          await waitFor(() => !finding(uri, kind), `${kind} clears after the fix`);

          const fixedLine = document.lineAt(diagnostic.range.start.line);
          const column = fixedLine.text.indexOf(newValue);
          assert.ok(column >= 0, "the corrected value stays on the diagnostic's line");
          const at = document.offsetAt(fixedLine.range.start) + column;
          const undo = new vscode.WorkspaceEdit();
          undo.replace(uri, new vscode.Range(document.positionAt(at), document.positionAt(at + newValue.length)), oldValue);
          await vscode.workspace.applyEdit(undo);
          await document.save();
          await waitFor(() => Boolean(finding(uri, kind)), `${kind} returns after restoring the mistake`);
        }
      } finally {
        // The text and the line endings: the editor writes the text back with the
        // document's current ones, which this test set to CRLF.
        const restore = new vscode.WorkspaceEdit();
        restore.set(uri, [
          vscode.TextEdit.replace(new vscode.Range(0, 0, document.lineCount, 0), original),
          vscode.TextEdit.setEndOfLine(originalEol),
        ]);
        await vscode.workspace.applyEdit(restore);
        await document.save();
        assert.deepEqual(
          Buffer.from(await vscode.workspace.fs.readFile(uri)),
          Buffer.from(originalBytes),
          "the fixture is left exactly as it was",
        );
      }
    }

    it("applies and clears the include quick fix over five rounds with CRLF", async function () {
      await exerciseFix(bundle, "include_matches_nothing", "resource/*.yml", "resources/*.yml");
    });

    it("applies and clears the renamed notebook quick fix over five rounds with CRLF", async function () {
      await exerciseFix(resource, "notebook_missing_extension", "../src/etl", "../src/etl.py");
    });

    it("keeps Problems entries and graph findings consistent after the repeated edits", async function () {
      await inspect();
      assertLinkedAndUnique();
      const data = await vscode.commands.executeCommand<{
        inspectorIssues: Array<{ kind: string; file?: string; line?: number }>;
      }>("databricksBundleInspector.test.graphData");
      assert.ok(data);
      const inGraph = data.inspectorIssues.filter(issue => issue.file)
        .map(issue => `${vscode.Uri.file(issue.file!).toString()}:${issue.line ?? 1}:${issue.kind}`).sort();
      const inProblems = diagnostics().map(({ uri, item }) =>
        `${uri.toString()}:${item.range.start.line + 1}:${codeValue(item.code)}`,
      ).sort();
      assert.deepEqual(inGraph, inProblems);
    });

    it("keeps 100 same-code findings separate and fixes only the selected task", async function () {
      const document = await vscode.workspace.openTextDocument(resource);
      const original = document.getText();
      async function replaceDocument(text: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(resource, new vscode.Range(0, 0, document.lineCount, 0), text);
        await vscode.workspace.applyEdit(edit);
        await document.save();
      }
      const missing = () => vscode.languages.getDiagnostics(resource)
        .filter(item => codeValue(item.code) === "notebook_missing_extension");
      try {
        const tasks = Array.from({ length: 100 }, (_, index) =>
          `        - task_key: extract_${index}\n          notebook_task:\n            notebook_path: ../src/etl`,
        ).join("\n");
        await replaceDocument(`resources:\n  jobs:\n    nightly:\n      name: issue_codes_nightly\n      bogus_job_field: true\n      tasks:\n${tasks}\n`);
        await waitFor(() => missing().length === 100, "all 100 findings");
        assertLinkedAndUnique();
        const last = missing().sort((left, right) => left.range.start.line - right.range.start.line).at(-1)!;
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider", resource, last.range, vscode.CodeActionKind.QuickFix.value,
        );
        const fix = actions.find(action => action.title === 'Change to "../src/etl.py"');
        assert.ok(fix?.edit);
        await vscode.workspace.applyEdit(fix.edit);
        assert.equal(document.lineAt(last.range.start.line).text.trim(), "notebook_path: ../src/etl.py");
        assert.equal(document.getText().split("notebook_path: ../src/etl.py").length - 1, 1);
        await document.save();
        await waitFor(() => missing().length === 99, "only the chosen finding clears");
        assertLinkedAndUnique();
      } finally {
        await replaceDocument(original);
        await waitFor(() => missing().length === 1, "original fixture restored");
      }
    });

    it("a missing notebook names the one that fits, opens it to the side, and changes the path to it", async function () {
      const document = await vscode.workspace.openTextDocument(resource);
      const original = document.getText();
      async function replaceDocument(text: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(resource, new vscode.Range(0, 0, document.lineCount, 0), text);
        await vscode.workspace.applyEdit(edit);
        await document.save();
      }
      try {
        const etl = path.join(path.dirname(path.dirname(resource.fsPath)), "src", "etl.py");
        await vscode.window.showTextDocument(document);
        await replaceDocument(original.replace("notebook_path: ../src/etl", "notebook_path: ../notebooks/etl.py"));
        await waitFor(() => Boolean(finding(resource, "missing_file")), "missing_file finding");
        const diagnostic = finding(resource, "missing_file")!;
        assert.equal(diagnostic.message, 'File not found: ../notebooks/etl.py. Did you mean "../src/etl.py"?');

        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider", resource, diagnostic.range, vscode.CodeActionKind.QuickFix.value,
        );
        const titles = actions.map(action => action.title);
        assert.ok(titles.includes('Change to "../src/etl.py"'), JSON.stringify(titles));
        const open = actions.find(action => action.title === 'Open "../src/etl.py" to the side');
        assert.ok(open?.command, JSON.stringify(titles));

        // Opens beside the YAML, which keeps the focus.
        await vscode.commands.executeCommand(open.command.command, ...(open.command.arguments ?? []));
        await waitFor(
          () => vscode.window.visibleTextEditors.some(editor => editor.document.uri.fsPath === etl),
          "the suggested notebook beside the YAML",
        );
        const beside = vscode.window.visibleTextEditors.find(editor => editor.document.uri.fsPath === etl)!;
        assert.notEqual(beside.viewColumn, vscode.window.visibleTextEditors.find(editor => editor.document === document)?.viewColumn);
        assert.equal(vscode.window.activeTextEditor?.document, document);

        const change = actions.find(action => action.title === 'Change to "../src/etl.py"')!;
        assert.ok(await vscode.workspace.applyEdit(change.edit!));
        await document.save();
        await waitFor(() => !finding(resource, "missing_file"), "missing_file clears once the path is changed");
      } finally {
        await replaceDocument(original);
        await waitFor(() => Boolean(finding(resource, "notebook_missing_extension")), "original fixture restored");
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });

    it("a suggested path with \" #\" in it is quoted, so YAML keeps it whole", async function () {
      const document = await vscode.workspace.openTextDocument(resource);
      const original = document.getText();
      const folder = vscode.Uri.file(path.join(path.dirname(path.dirname(resource.fsPath)), "team #2"));
      async function replaceDocument(text: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(resource, new vscode.Range(0, 0, document.lineCount, 0), text);
        await vscode.workspace.applyEdit(edit);
        await document.save();
      }
      try {
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(folder, "moved.py"),
          Buffer.from("# Databricks notebook source\nprint(1)\n"),
        );
        await replaceDocument(original.replace("notebook_path: ../src/etl", "notebook_path: ../notebooks/moved.py"));
        await waitFor(() => Boolean(finding(resource, "missing_file")), "missing_file finding");
        const diagnostic = finding(resource, "missing_file")!;
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider", resource, diagnostic.range, vscode.CodeActionKind.QuickFix.value,
        );
        const change = actions.find(action => action.title === 'Change to "../team #2/moved.py"');
        assert.ok(change?.edit, JSON.stringify(actions.map(action => action.title)));
        assert.ok(await vscode.workspace.applyEdit(change.edit));
        // Unquoted, YAML would read "../team" and take the rest as a comment.
        assert.equal(document.lineAt(diagnostic.range.start.line).text.trim(), "notebook_path: '../team #2/moved.py'");
        await document.save();
        await waitFor(() => !finding(resource, "missing_file"), "missing_file clears once the path is changed");
      } finally {
        await replaceDocument(original);
        await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
        await waitFor(() => Boolean(finding(resource, "notebook_missing_extension")), "original fixture restored");
      }
    });

    it("rejects stale Quick Fixes after unsaved edits and leaves repeated text in comments alone", async function () {
      for (const example of [
        { uri: bundle, kind: "include_matches_nothing", prefix: "  - ", oldValue: "resource/*.yml", newValue: "resources/*.yml" },
        { uri: resource, kind: "notebook_missing_extension", prefix: "            notebook_path: ", oldValue: "../src/etl", newValue: "../src/etl.py" },
      ]) {
        await inspect();
        const document = await vscode.workspace.openTextDocument(example.uri);
        const original = document.getText();
        const diagnostic = finding(example.uri, example.kind)!;
        const line = diagnostic.range.start.line;
        const title = `Change to "${example.newValue}"`;
        async function changeLine(text: string): Promise<void> {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(example.uri, document.lineAt(line).range, example.prefix + text);
          await vscode.workspace.applyEdit(edit);
        }
        async function fixes(): Promise<vscode.CodeAction[]> {
          const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            "vscode.executeCodeActionProvider", example.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value,
          );
          return actions.filter(action => action.title === title);
        }
        try {
          for (const text of [
            `${example.oldValue} ${example.oldValue}`,
            `"${example.oldValue} ${example.oldValue}"`,
            `'${example.oldValue}' trailing`,
            `prefix/${example.oldValue}`,
            `"${example.oldValue.replace("/", "\\u002f")}"`,
          ]) {
            await changeLine(text);
            assert.ok(finding(example.uri, example.kind), "the old diagnostic must still be present before saving");
            assert.equal((await fixes()).length, 0, `do not change a different YAML value: ${text}`);
          }
          await changeLine(`${example.oldValue} # keep ${example.oldValue}`);
          const fix = (await fixes())[0];
          assert.ok(fix?.edit, "a comment does not change the YAML value");
          await vscode.workspace.applyEdit(fix.edit);
          assert.equal(document.lineAt(line).text, `${example.prefix}${example.newValue} # keep ${example.oldValue}`);
        } finally {
          const restore = new vscode.WorkspaceEdit();
          restore.replace(example.uri, new vscode.Range(0, 0, document.lineCount, 0), original);
          await vscode.workspace.applyEdit(restore);
          await document.save();
          await inspect();
        }
      }
    });

    it("keeps 900 unchecked-path notes correct through repeated edits in a 1,000-task job", async function () {
      const document = await vscode.workspace.openTextDocument(resource);
      const original = document.getText();
      const notes = () => vscode.languages.getDiagnostics(resource).filter(item => codeValue(item.code) === "path_not_checked");
      const graph = () => vscode.commands.executeCommand<{
        inspectorIssues: Array<{ kind: string; file?: string; line?: number }>;
      }>("databricksBundleInspector.test.graphData");
      try {
        for (const variablePaths of [true, false, true, false]) {
          const tasks = Array.from({ length: 1000 }, (_, index) =>
            `        - task_key: extract_${index}\n          notebook_task:\n            notebook_path: ${variablePaths && index < 900 ? "${workspace.file_path}/src/etl.py" : "../src/etl.py"}`,
          ).join("\n");
          const edit = new vscode.WorkspaceEdit();
          edit.replace(resource, new vscode.Range(0, 0, document.lineCount, 0), `resources:\n  jobs:\n    nightly:\n      name: issue_codes_nightly\n      bogus_job_field: true\n      tasks:\n${tasks}\n`);
          await vscode.workspace.applyEdit(edit);
          await document.save();
          const expected = variablePaths ? 900 : 0;
          await waitFor(() => notes().length === expected, `${expected} unchecked paths after saving 1,000 tasks`);
          await waitFor(async () => {
            const data = await graph();
            return data?.inspectorIssues.filter(issue => issue.kind === "path_not_checked").length === expected;
          }, "the graph matching the saved Problems entries");
          for (const item of notes()) {
            assert.equal(item.severity, vscode.DiagnosticSeverity.Information);
            assert.equal(document.lineAt(item.range.start.line).text.trim(), "notebook_path: ${workspace.file_path}/src/etl.py");
            assert.equal(typeof item.code, "object");
            if (typeof item.code === "object") assert.ok(item.code.target.fragment === "path_not_checked");
          }
          assertLinkedAndUnique(3);
          assert.equal(vscode.languages.getDiagnostics(resource).filter(item => codeValue(item.code) === "missing_file").length, 0);
        }
      } finally {
        const restore = new vscode.WorkspaceEdit();
        restore.replace(resource, new vscode.Range(0, 0, document.lineCount, 0), original);
        await vscode.workspace.applyEdit(restore);
        await document.save();
        await waitFor(() => Boolean(finding(resource, "notebook_missing_extension")), "the original one-task fixture restored");
      }
    });
  });
}

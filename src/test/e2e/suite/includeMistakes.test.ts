import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as vscode from "vscode";

/** How long to leave the result on screen before the window closes. 0 in normal runs. */
const PAUSE_MS = Number(process.env.E2E_PAUSE_MS ?? 0);
const INCLUDE_KINDS = new Set(["include_matches_nothing", "resource_not_included"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function databricksCliAvailable(): boolean {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** The include warnings currently in the Problems panel, as `file:line message`. */
function includeProblems(root: string): { file: string; line: number; kind: string; message: string }[] {
  return vscode.languages
    .getDiagnostics()
    .flatMap(([uri, diagnostics]) =>
      diagnostics
        .filter((d) => INCLUDE_KINDS.has(String(d.code)))
        .map((d) => ({
          file: path.relative(root, uri.fsPath).split(path.sep).join("/"),
          line: d.range.start.line + 1,
          kind: String(d.code),
          message: d.message,
        })),
    )
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Opens the include-mistakes fixture with a real Databricks CLI and checks that the
 * inspector reports the mistakes the CLI accepts silently. Run it with
 * `npm run test:e2e:include:watch` to watch the Problems panel fill in.
 */
export function includeMistakesSuite() {
  describe("include mistakes (needs a real Databricks CLI)", function () {
    before(function () {
      if (!databricksCliAvailable()) this.skip();
    });

    it("shows a warning for each mistake in the Problems panel and leaves the skipped file alone", async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the include-mistakes fixture should be the open folder");

      const bundleFile = await vscode.workspace.openTextDocument(path.join(root, "databricks.yml"));
      await vscode.window.showTextDocument(bundleFile);
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");

      // The warnings are written before the command returns, but give a slow CLI a moment.
      for (let waited = 0; includeProblems(root).length < 3 && waited < 30_000; waited += 500) await sleep(500);

      // Show it: the file with its squiggle beside the inspector, and the Problems panel below.
      await vscode.window.showTextDocument(bundleFile, { viewColumn: vscode.ViewColumn.Two, preserveFocus: true });
      await vscode.commands.executeCommand("workbench.actions.view.problems");
      if (PAUSE_MS > 0) await sleep(PAUSE_MS);

      const problems = includeProblems(root);
      assert.deepEqual(
        problems.map(({ file, line, kind }) => ({ file, line, kind })),
        [
          { file: "databricks.yml", line: 9, kind: "include_matches_nothing" },
          { file: "resources/jobs/nested.job.yml", line: 1, kind: "resource_not_included" },
          { file: "resources/legacy.job.yaml", line: 1, kind: "resource_not_included" },
        ],
      );
      assert.match(problems[0]!.message, /Did you mean "resources\/\*\.yml"\?/);
      assert.ok(
        !problems.some((p) => p.file === "paused/job.yml"),
        "paused/job.yml is named in a comment in databricks.yml, so it must not be reported",
      );

      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    it("fixes the misspelled include from the Quick Fix menu, and the warning goes on save", async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the include-mistakes fixture should be the open folder");
      const bundleUri = vscode.Uri.file(path.join(root, "databricks.yml"));
      const original = await vscode.workspace.fs.readFile(bundleUri);
      const matchesNothing = () => includeProblems(root).filter((p) => p.kind === "include_matches_nothing");

      try {
        const document = await vscode.workspace.openTextDocument(bundleUri);
        await vscode.window.showTextDocument(document);
        const problem = vscode.languages
          .getDiagnostics(bundleUri)
          .find((d) => d.code === "include_matches_nothing");
        assert.ok(problem, "the misspelled include should be reported before it is fixed");

        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider",
          bundleUri,
          problem.range,
          vscode.CodeActionKind.QuickFix.value,
        );
        const fix = actions.find((action) => action.title === 'Change to "resources/*.yml"');
        assert.ok(fix?.edit, `expected the include fix, got: ${actions.map((a) => a.title).join(", ")}`);
        assert.equal(fix.isPreferred, true);

        await vscode.workspace.applyEdit(fix.edit);
        assert.equal(document.lineAt(problem.range.start.line).text, "  - resources/*.yml");
        if (PAUSE_MS > 0) await sleep(PAUSE_MS);
        await document.save();

        for (let waited = 0; matchesNothing().length > 0 && waited < 30_000; waited += 500) await sleep(500);
        assert.deepEqual(matchesNothing(), [], "saving the fix clears the warning");
      } finally {
        await vscode.workspace.fs.writeFile(bundleUri, original);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });

    it("offers no fix once the entry no longer says what the check read", async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the include-mistakes fixture should be the open folder");
      const bundleUri = vscode.Uri.file(path.join(root, "databricks.yml"));
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
      for (let waited = 0; includeProblems(root).length < 3 && waited < 30_000; waited += 500) await sleep(500);

      const document = await vscode.workspace.openTextDocument(bundleUri);
      await vscode.window.showTextDocument(document);
      const problem = vscode.languages.getDiagnostics(bundleUri).find((d) => d.code === "include_matches_nothing");
      assert.ok(problem, "the misspelled include should be reported again");

      try {
        // Edit the entry without saving, so the check still holds the old value.
        const line = problem.range.start.line;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(bundleUri, document.lineAt(line).range, "  - resourcez/*.yml");
        await vscode.workspace.applyEdit(edit);

        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider",
          bundleUri,
          problem.range,
          vscode.CodeActionKind.QuickFix.value,
        );
        assert.deepEqual(actions.filter((action) => action.title.startsWith("Change to")).map((a) => a.title), []);
      } finally {
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      }
    });

    it("the graph reports the same include mistakes as the Problems panel", async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the include-mistakes fixture should be the open folder");
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, "databricks.yml")));
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
      for (let waited = 0; includeProblems(root).length < 3 && waited < 30_000; waited += 500) await sleep(500);

      const graph = await vscode.commands.executeCommand<{
        inspectorIssues?: { kind: string; file?: string; line?: number }[];
      }>("databricksBundleInspector.test.graphData");
      const inGraph = (graph?.inspectorIssues ?? [])
        .filter((issue) => INCLUDE_KINDS.has(issue.kind) && issue.file)
        .map((issue) => ({
          file: path.relative(root, issue.file!).split(path.sep).join("/"),
          line: issue.line ?? 1,
          kind: issue.kind,
        }))
        .sort((a, b) => a.file.localeCompare(b.file));
      assert.deepEqual(
        inGraph,
        includeProblems(root).map(({ file, line, kind }) => ({ file, line, kind })),
      );
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });
  });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { codeValue } from "../../../bundle/issueDocs.js";

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
        .filter((d) => INCLUDE_KINDS.has(codeValue(d.code) ?? ""))
        .map((d) => ({
          file: path.relative(root, uri.fsPath).split(path.sep).join("/"),
          line: d.range.start.line + 1,
          kind: codeValue(d.code) ?? "",
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
      // Each code links to its section in the docs, at this version's tag.
      const code = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(root, "databricks.yml")))
        .find((d) => codeValue(d.code) === "include_matches_nothing")?.code;
      assert.ok(typeof code === "object", "the code should carry a link");
      assert.match(code.target.toString(), /\/blob\/v\d+\.\d+\.\d+\/docs\/checks\.md#include_matches_nothing$/);
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
          .find((d) => codeValue(d.code) === "include_matches_nothing");
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
      const problem = vscode.languages.getDiagnostics(bundleUri).find((d) => codeValue(d.code) === "include_matches_nothing");
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

    it("opens the graph from a resource file include loads, on the job under the cursor", async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the include-mistakes fixture should be the open folder");
      type GraphData = { initialJob?: { key: string; nonce: number } | null; parsedBundle?: { bundle?: { name?: string } } };
      // A check has run: the always-on check on open, or the tests above.
      for (let waited = 0; includeProblems(root).length < 3 && waited < 30_000; waited += 500) await sleep(500);

      const resourceFile = await vscode.workspace.openTextDocument(path.join(root, "resources", "top.job.yml"));
      const editor = await vscode.window.showTextDocument(resourceFile);
      const secondJobLine = resourceFile.getText().split(/\r?\n/).findIndex((line) => line.includes("second_job:"));
      editor.selection = new vscode.Selection(secondJobLine + 2, 0, secondJobLine + 2, 0);
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
      const fromSecond = await vscode.commands.executeCommand<GraphData>("databricksBundleInspector.test.graphData");
      assert.equal(fromSecond?.initialJob?.key, "second_job");
      assert.equal(fromSecond?.parsedBundle?.bundle?.name, "include-mistakes");

      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
      const fromTop = await vscode.commands.executeCommand<GraphData>("databricksBundleInspector.test.graphData");
      assert.equal(fromTop?.initialJob?.key, "top_job", "above the jobs, the file's first job");
      if (PAUSE_MS > 0) await sleep(PAUSE_MS);

      // A file include doesn't load is not part of the bundle, so Inspect doesn't open it.
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, "resources", "legacy.job.yaml")));
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
      const afterLegacy = await vscode.commands.executeCommand<GraphData>("databricksBundleInspector.test.graphData");
      assert.equal(afterLegacy?.initialJob?.nonce, fromTop?.initialJob?.nonce, "nothing new was sent to the graph");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    // Go's filepath.Match, which the CLI uses for include: "On Windows, escaping is
    // disabled. Instead, '\\' is treated as path separator." Elsewhere `\*` is a literal `*`.
    it("reads a backslash in an include entry as the CLI does on this platform", async function () {
      const windows = process.platform === "win32";
      const dir = mkdtempSync(path.join(os.tmpdir(), "dbi-include-backslash-"));
      const bundleFile = path.join(dir, "databricks.yml");
      const writeInclude = (entry: string) =>
        // Plain YAML: in double quotes `\*` would be an escape sequence.
        writeFileSync(bundleFile, `bundle:\n  name: include_backslash\ninclude:\n  - ${entry}\n`);
      try {
        mkdirSync(path.join(dir, "resources"));
        writeFileSync(path.join(dir, "resources", "job.yml"), "resources:\n  jobs:\n    j:\n      name: j\n");

        // First, what the CLI itself loads, so the test checks the assumption behind the fix.
        writeInclude("resources\\*.yml");
        let stdout: string;
        try {
          stdout = execFileSync("databricks", ["bundle", "validate", "-o", "json"], {
            cwd: dir,
            encoding: "utf8",
            timeout: 30_000,
            env: { ...process.env, DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          // Without a workspace login the CLI exits non-zero but still prints the bundle.
          stdout = String((error as { stdout?: unknown }).stdout ?? "");
        }
        const loaded = (JSON.parse(stdout) as { include?: string[] }).include ?? [];
        assert.equal(loaded.length, windows ? 1 : 0, `the CLI loaded ${JSON.stringify(loaded)}`);

        // Then the inspector, with a .yaml entry for files that end in .yml.
        writeInclude("resources\\*.yaml");
        await vscode.window.showTextDocument(vscode.Uri.file(bundleFile));
        await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
        for (let waited = 0; waited < 30_000; waited += 500) {
          const data = await vscode.commands.executeCommand<{ parsedBundle?: { bundle?: { name?: string } } }>(
            "databricksBundleInspector.test.graphData",
          );
          if (data?.parsedBundle?.bundle?.name === "include_backslash") break;
          await sleep(500);
        }
        const warnings = vscode.languages
          .getDiagnostics(vscode.Uri.file(bundleFile))
          .filter((d) => codeValue(d.code) === "include_matches_nothing");
        if (!windows) {
          assert.deepEqual(warnings.map((d) => d.message), [], "an escaped * matches nothing, and so does its .yml twin");
          return;
        }
        assert.equal(warnings.length, 1, "the .yaml entry matches nothing on Windows");
        assert.match(warnings[0]!.message, /Did you mean "resources\\\*\.yml"\?/);
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider",
          vscode.Uri.file(bundleFile),
          warnings[0]!.range,
          vscode.CodeActionKind.QuickFix.value,
        );
        assert.ok(actions.some((action) => action.title === 'Change to "resources\\*.yml"'), "the light bulb offers the fix");
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

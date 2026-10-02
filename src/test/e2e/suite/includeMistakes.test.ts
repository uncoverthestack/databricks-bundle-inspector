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
  });
}

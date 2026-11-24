import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { connectBrowser, panelSizer, STANDARD_PANEL, type Browser, type PanelSize, type PanelSizer } from "./browser.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

const JOB = "resources.jobs.runtime_secrets";

/** The Uses row's secret scope chips: text, dashed or not, and whether they show the key. */
const CHIPS = `[...document.querySelectorAll('[aria-label="What this job uses"] button')]
  .filter((chip) => chip.querySelector('[data-type-dot="secret_scope"]'))
  .map((chip) => ({
    text: chip.textContent.replace(/\\s+/g, " ").trim(),
    dashed: getComputedStyle(chip).borderTopStyle === "dashed",
    key: Boolean(chip.querySelector('[data-type-icon="key"]')),
  }))`;

/**
 * Secrets whose scope the code doesn't name (issue 535), in the real panel: the Uses row never
 * joins two unknown scopes, and pointing at one lights only its own task.
 */
export function runtimeSecretsSuite() {
  describe("secret scopes set at run time", function () {
    this.timeout(120_000);
    let browser: Browser;
    let sessionId = "";
    let contextId = 0;
    let sizer: PanelSizer;
    const shots = path.resolve(__dirname, "../runtime-secrets");

    const evaluate = async (expression: string) => {
      const result = await browser.call("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId);
      assert.ok(!result.exceptionDetails, `script must run: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result?.value;
    };
    const panelSize = () => evaluate("({ width: innerWidth, height: innerHeight })") as Promise<PanelSize>;

    const screenshot = async (name: string) => {
      const { targetInfos } = await browser.call("Target.getTargets");
      const page = targetInfos.find((item: any) => item.type === "page" && item.url.includes("workbench"));
      if (!page) return;
      const { sessionId: pageSession } = await browser.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const { data } = await browser.call("Page.captureScreenshot", { format: "png" }, pageSession);
      mkdirSync(shots, { recursive: true });
      writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
      await browser.call("Target.detachFromTarget", { sessionId: pageSession });
    };

    before(async function () {
      assert.ok(process.env.E2E_CDP_PORT, "run with npm run test:e2e:runtime-secrets");
      browser = await connectBrowser(process.env.E2E_CDP_PORT);
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "databricks.yml"))));
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
      await waitFor(async () => {
        const { targetInfos } = await browser.call("Target.getTargets");
        for (const target of targetInfos.filter((item: any) => item.type === "iframe" && item.url.startsWith("vscode-webview://"))) {
          const attached = await browser.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
          const { frameTree } = await browser.call("Page.getFrameTree", {}, attached.sessionId);
          const frames: any[] = [];
          const visit = (node: any) => { frames.push(node.frame); for (const child of node.childFrames ?? []) visit(child); };
          visit(frameTree);
          for (const frame of frames) {
            const world = await browser.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dbi-runtime-secrets-test" }, attached.sessionId);
            sessionId = attached.sessionId;
            contextId = world.executionContextId;
            if (await evaluate(`Boolean(document.querySelector('[data-overview-item="${JOB}"]')) && !(innerWidth === 300 && innerHeight === 150)`)) return true;
          }
          await browser.call("Target.detachFromTarget", { sessionId: attached.sessionId });
        }
        return false;
      }, "the overview with the job");
      sizer = await panelSizer(browser, panelSize);
      await sizer.set(STANDARD_PANEL);
    });

    after(async () => {
      await sizer?.release().catch(() => undefined);
      browser?.close();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    it("the overview lists them in the job's details, with no box of their own", async () => {
      await evaluate(`document.querySelector('[data-overview-item="${JOB}"]').click()`);
      await waitFor(async () => await evaluate(`Boolean(document.querySelector("[data-overview-runtime-secrets]"))`), "the job's details");
      const shown = await evaluate(`({
        lines: [...document.querySelectorAll("[data-overview-runtime-secrets] > div[title]")].map((row) => row.textContent.replace(/\\s+/g, " ").trim()),
        boxes: [...document.querySelectorAll("[data-overview-item]")].map((box) => box.textContent),
      })`);
      assert.deepEqual(shown.lines, [
        "From job parameter shared_scopec_shared, d_shared",
        "From parameter task_scopef_variable",
        "Set at run timea_built",
        "Set at run timeb_built",
      ]);
      assert.equal(shown.boxes.some((text: string) => /run time|parameter/.test(text)), false, "no box for an unknown scope");
      await screenshot("overview-details");
    });

    it("the Uses row gives each unknown scope its own dashed chip with the key", async () => {
      await evaluate(`document.querySelector('[data-overview-open="${JOB}"]').click()`);
      await waitFor(async () => (await evaluate(CHIPS)).length === 5, "the job's Uses row");
      assert.deepEqual(await evaluate(CHIPS), [
        { text: "billing-kv · by default · secret scope · 1 task", dashed: true, key: true },
        { text: "From job parameter shared_scope · secret scope · 2 tasks", dashed: true, key: true },
        { text: "From parameter task_scope · secret scope · f_variable", dashed: true, key: true },
        { text: "Set at run time · secret scope · a_built", dashed: true, key: true },
        { text: "Set at run time · secret scope · b_built", dashed: true, key: true },
      ]);
      await screenshot("uses-row");
    });

    it("pinning an unknown scope lights only its own task", async () => {
      const lit = () => evaluate(`[...document.querySelectorAll(".react-flow__node")]
        .filter((node) => Number(getComputedStyle(node.firstElementChild ?? node).opacity) > 0.5 && Number(node.style.opacity || 1) > 0.5)
        .map((node) => node.dataset.id.split(".").pop()).sort()`);
      const pin = (text: string) => evaluate(`[...document.querySelectorAll('[aria-label="What this job uses"] button')].find((chip) => chip.textContent.includes(${JSON.stringify(text)})).click()`);
      await pin("a_built");
      await waitFor(async () => (await lit()).length === 1, "one task lit");
      assert.deepEqual(await lit(), ["a_built"]);
      await pin("a_built");
      await pin("2 tasks");
      await waitFor(async () => (await lit()).length === 2, "the job parameter's two tasks lit");
      assert.deepEqual(await lit(), ["c_shared", "d_shared"]);
      await screenshot("uses-pinned");
    });
  });
}

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { connectBrowser, type Browser } from "./browser.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

const CLUSTER = "resources.clusters.shared_etl";
const SCOPE = "resources.secret_scopes.app_secrets";

/** What the overview shows: its boxes, which are faded, its lines, and the open details. */
const READ = `(() => {
  const boxes = [...document.querySelectorAll("[data-overview-item]")].map((box) => ({
    id: box.dataset.overviewItem,
    pressed: box.getAttribute("aria-pressed") === "true",
    faded: Number(getComputedStyle(box).opacity) < 1,
  }));
  return {
    boxes,
    links: [...document.querySelectorAll("[data-overview-link]")].map((link) => link.dataset.overviewLink),
    unchecked: [...document.querySelectorAll("[data-overview-group][data-unchecked]")].map((group) => group.dataset.overviewGroup),
    details: document.querySelector("[data-overview-details]")?.dataset.overviewDetails ?? null,
  };
})()`;

/**
 * A bundle with no job and no pipeline opens on the bundle overview. Checked in the real
 * panel because the lines are measured from the boxes on screen.
 */
export function overviewSuite() {
  describe("bundle overview", function () {
    this.timeout(120_000);
    let browser: Browser;
    let sessionId = "";
    let contextId = 0;
    const shots = path.resolve(__dirname, "../overview");

    const evaluate = async (expression: string) => {
      const result = await browser.call("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId);
      assert.ok(!result.exceptionDetails, `overview script must run: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result?.value;
    };
    const read = () => evaluate(READ) as Promise<{
      boxes: { id: string; pressed: boolean; faded: boolean }[];
      links: string[];
      unchecked: string[];
      details: string | null;
    }>;
    const click = (id: string) =>
      evaluate(`document.querySelector('[data-overview-item="${id}"]').click()`);

    /** Opens the panel and attaches to the frame that renders the overview. */
    const openOverview = async () => {
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      const config = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "databricks.yml")));
      await vscode.window.showTextDocument(config);
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
            const world = await browser.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dbi-overview-test" }, attached.sessionId);
            sessionId = attached.sessionId;
            contextId = world.executionContextId;
            if (await evaluate(`document.querySelectorAll("[data-overview-item]").length`) > 0) return true;
          }
          await browser.call("Target.detachFromTarget", { sessionId: attached.sessionId });
        }
        return false;
      }, "the rendered overview");
    };

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
      assert.ok(process.env.E2E_CDP_PORT, "run with npm run test:e2e:overview");
      browser = await connectBrowser(process.env.E2E_CDP_PORT);
      await openOverview();
    });

    after(async () => {
      browser?.close();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    it("shows a box for every resource, and the line the bundle has", async () => {
      await waitFor(async () => (await read()).links.length === 1, "the cluster's line to its secret scope");
      const shown = await read();
      assert.deepEqual(shown.boxes.map((box) => box.id).sort(), [
        CLUSTER,
        "resources.experiments.tracking",
        "resources.schemas.sales",
        SCOPE,
        "resources.sql_warehouses.analytics",
        "resources.volumes.raw_files",
      ]);
      assert.deepEqual(shown.links, [`${CLUSTER}->${SCOPE}`]);
      assert.equal(shown.boxes.some((box) => box.faded), false, "nothing is faded until a box is active");
      assert.equal(shown.details, null);
      // Groups the inspector has no checks or lines for say so. Compute and Secrets do not.
      assert.deepEqual(shown.unchecked.sort(), ["machine_learning", "unity_catalog"]);
      await screenshot("overview");
    });

    it("selecting a box keeps its link lit, fades the rest and shows its details", async () => {
      await click(CLUSTER);
      await waitFor(async () => (await read()).details === CLUSTER, "the cluster's details");
      const shown = await read();
      const state = Object.fromEntries(shown.boxes.map((box) => [box.id, box]));
      assert.equal(state[CLUSTER]!.pressed, true);
      assert.equal(state[CLUSTER]!.faded, false);
      assert.equal(state[SCOPE]!.faded, false, "the linked secret scope stays lit");
      assert.equal(shown.boxes.filter((box) => box.faded).length, 4, "the four unlinked boxes fade");
      await screenshot("overview-selected");
    });

    it("the details open the resource's YAML on its own line", async () => {
      await evaluate(`document.querySelector("[data-overview-open-file]").click()`);
      await waitFor(async () => {
        const editor = vscode.window.activeTextEditor;
        return Boolean(editor?.document.fileName.endsWith("databricks.yml")) &&
          editor!.document.lineAt(editor!.selection.active.line).text.trim() === "shared_etl:";
      }, "the cursor on the cluster's key");
    });

    it("clicking the box again clears the selection", async () => {
      await click(CLUSTER);
      await waitFor(async () => (await read()).details === null, "the details to close");
      assert.equal((await read()).boxes.some((box) => box.pressed), false);
    });

    it("typing in the header's search lights the matching box and fades the rest; Esc clears it", async () => {
      const type = (text: string) => evaluate(`(() => {
        const input = document.querySelector('header input[aria-label="Find a resource"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      })()`);
      await type("shared");
      await waitFor(async () => (await read()).boxes.filter((box) => box.faded).length === 4, "the search to fade the other boxes");
      const shown = Object.fromEntries((await read()).boxes.map((box) => [box.id, box]));
      assert.equal(shown[CLUSTER]!.faded, false, "the match stays lit");
      assert.equal(shown[SCOPE]!.faded, false, "what the match links to stays lit");
      await evaluate(`document.querySelector('header input[aria-label="Find a resource"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await waitFor(async () => (await read()).boxes.every((box) => !box.faded), "Esc to clear the search");
    });

    it("Issues on a bundle with no problems says so, and Show all brings every box back", async () => {
      const issues = `[...document.querySelectorAll('header button')].find((button) => button.textContent.trim().startsWith('Issues'))`;
      await evaluate(`${issues}.click()`);
      await waitFor(async () => (await read()).boxes.length === 0, "Issues to keep only boxes with a problem");
      assert.equal(await evaluate(`document.body.textContent.includes("No problems found in this bundle.")`), true);
      assert.match(await evaluate(`document.querySelector("[data-overview-show-all]").textContent`), /^6 resources with no problems/);
      await evaluate(`document.querySelector("[data-overview-show-all]").click()`);
      await waitFor(async () => (await read()).boxes.length === 6, "every box again");
    });
  });
}

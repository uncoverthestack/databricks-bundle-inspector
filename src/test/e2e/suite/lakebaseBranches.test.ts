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

const PROJECT = "resources.postgres_projects.orders_db";
const DEV = "resources.postgres_branches.dev";
const FEATURE = "resources.postgres_branches.feature_x";
const RESTORE = "resources.postgres_branches.restore";
const PRODUCTION = `${PROJECT}#branch:production`;

/** The rows on the branches page, in order, with how far each steps in and whether it is selected. */
const ROWS = `[...document.querySelectorAll("[data-branch-row]")].map((row) => ({
  id: row.dataset.branchRow,
  left: Math.round(row.getBoundingClientRect().left),
  pressed: row.getAttribute("aria-pressed") === "true",
}))`;

/**
 * A Lakebase project's branches page (issue 543), in the real panel: opened from the project's
 * box, a tree of branches, branch details on the right, and back to the overview.
 */
export function lakebaseBranchesSuite() {
  describe("Lakebase branches page", function () {
    this.timeout(120_000);
    let browser: Browser;
    let sessionId = "";
    let contextId = 0;
    let sizer: PanelSizer;
    const shots = path.resolve(__dirname, "../lakebase-branches");

    const evaluate = async (expression: string) => {
      const result = await browser.call("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId);
      assert.ok(!result.exceptionDetails, `script must run: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result?.value;
    };
    const panelSize = () => evaluate("({ width: innerWidth, height: innerHeight })") as Promise<PanelSize>;
    const rows = () => evaluate(ROWS) as Promise<Array<{ id: string; left: number; pressed: boolean }>>;
    const onPage = async () => Boolean(await evaluate(`Boolean(document.querySelector('[data-branches-page="orders_db"]'))`));

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

    /** Opens the panel on the overview and attaches to the page on screen. */
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
            const world = await browser.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dbi-lakebase-test" }, attached.sessionId);
            sessionId = attached.sessionId;
            contextId = world.executionContextId;
            if (await evaluate(`(Boolean(document.querySelector('[data-overview-item="${PROJECT}"]')) || Boolean(document.querySelector("[data-branches-page]"))) && !(innerWidth === 300 && innerHeight === 150)`)) return true;
          }
          await browser.call("Target.detachFromTarget", { sessionId: attached.sessionId });
        }
        return false;
      }, "the overview with the Lakebase project");
    };

    before(async function () {
      assert.ok(process.env.E2E_CDP_PORT, "run with npm run test:e2e:lakebase-branches");
      browser = await connectBrowser(process.env.E2E_CDP_PORT);
      await openOverview();
      sizer = await panelSizer(browser, panelSize);
      await sizer.set(STANDARD_PANEL);
    });

    after(async () => {
      await sizer?.release().catch(() => undefined);
      browser?.close();
      await vscode.workspace.getConfiguration("workbench").update("colorTheme", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    it("the overview has one box for the project, with a Branches link; its branches have none", async () => {
      const boxes = await evaluate(`[...document.querySelectorAll("[data-overview-item]")].map((box) => box.dataset.overviewItem)`);
      assert.ok(boxes.includes(PROJECT), `the project has a box: ${boxes}`);
      for (const folded of [DEV, FEATURE, RESTORE, "resources.postgres_endpoints.dev_rw", "resources.postgres_databases.app_db"]) {
        assert.ok(!boxes.includes(folded), `${folded} is inside the project's page, not a box`);
      }
      // In a project the bundle doesn't define, so it keeps its box.
      assert.ok(boxes.includes("resources.postgres_branches.reports"));
      assert.equal(await evaluate(`document.querySelector('[data-overview-open="${PROJECT}"]')?.textContent`), "Branches ›");
      // The app's line goes to the project now that its database is inside it.
      await evaluate(`document.querySelector('[data-overview-item="resources.apps.orders_app"]').click()`);
      await waitFor(async () => Boolean(await evaluate(`Boolean(document.querySelector('[data-overview-details="resources.apps.orders_app"]'))`)), "the app's details");
      assert.match(await evaluate(`document.querySelector('[data-overview-details="resources.apps.orders_app"]').innerText`), /orders_db/);
      await screenshot("overview");
    });

    it("Branches opens the tree: each branch under the one it was made from, the snapshot branch below", async () => {
      await evaluate(`document.querySelector('[data-overview-open="${PROJECT}"]').click()`);
      await waitFor(onPage, "the branches page");
      const shown = await rows();
      assert.deepEqual(shown.map((row) => row.id), [PRODUCTION, DEV, FEATURE, RESTORE]);
      const [production, dev, feature] = shown;
      assert.ok(dev!.left > production!.left && feature!.left > dev!.left, `each level steps in: ${JSON.stringify(shown)}`);
      assert.equal(await evaluate(`document.querySelector("[data-branch-count]").textContent`), "3 branches · 1 from a snapshot");
      assert.ok(shown.every((row) => !row.pressed), "nothing is selected at first");
      // production and dev each have a branch made from them, so each draws a line down to it.
      assert.equal(await evaluate(`document.querySelectorAll("[data-branch-trunk]").length`), 2);
      await screenshot("branches");
    });

    it("selecting a branch shows its details; arrow keys move to the next branch", async () => {
      await evaluate(`document.querySelector('[data-branch-row="${DEV}"]').click()`);
      await waitFor(async () => Boolean(await evaluate(`Boolean(document.querySelector('[data-branch-details="${DEV}"]'))`)), "dev's details");
      const details = await evaluate(`document.querySelector('[data-branch-details="${DEV}"]').innerText`);
      assert.match(details, /dev_rw/);
      assert.match(details, /production/);
      await screenshot("branch-selected");
      await evaluate(`document.querySelector('[data-branch-row="${DEV}"]').focus()`);
      await browser.call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }, sessionId);
      await browser.call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }, sessionId);
      await waitFor(async () => (await rows()).find((row) => row.id === FEATURE)?.pressed === true, "feature_x selected");
      assert.equal((await rows()).filter((row) => row.pressed).length, 1);
    });

    it("the light theme draws the same page", async () => {
      await vscode.workspace.getConfiguration("workbench").update("colorTheme", "Default Light Modern", vscode.ConfigurationTarget.Global);
      await sleep(800);
      assert.ok(await onPage());
      await screenshot("branches-light");
      await vscode.workspace.getConfiguration("workbench").update("colorTheme", undefined, vscode.ConfigurationTarget.Global);
      await sleep(500);
    });

    it("a narrow panel puts the details below and never scrolls the page sideways", async () => {
      try {
        await sizer.set({ width: 420, height: STANDARD_PANEL.height });
        await sleep(300);
        const layout = await evaluate(`(() => {
          const page = document.querySelector("[data-branches-page]");
          const aside = page.querySelector("aside").getBoundingClientRect();
          const list = page.querySelector('[role="list"]').getBoundingClientRect();
          const name = page.querySelector('[data-branch-row="${FEATURE}"] .font-semibold');
          return { below: aside.top >= list.top, sideways: document.documentElement.scrollWidth > innerWidth + 1, nameCut: name.scrollWidth > name.clientWidth };
        })()`);
        assert.deepEqual(layout, { below: true, sideways: false, nameCut: false });
        await screenshot("branches-narrow");
      } finally {
        await sizer.set(STANDARD_PANEL);
      }
    });

    it("the back arrow returns to the overview", async () => {
      await evaluate(`document.querySelector("[data-back-to-overview]").click()`);
      await waitFor(async () => !(await onPage()), "the overview");
      assert.ok(await evaluate(`Boolean(document.querySelector('[data-overview-item="${PROJECT}"]'))`));
    });
  });
}

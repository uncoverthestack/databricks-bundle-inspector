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

    it("a narrow panel stacks the columns, draws no lines and never scrolls sideways", async () => {
      const { targetInfos } = await browser.call("Target.getTargets");
      const page = targetInfos.find((item: any) => item.type === "page" && item.url.includes("workbench"));
      const { sessionId: pageSession } = await browser.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      // An earlier test opened the YAML beside the panel; it would take the room the panel needs.
      for (const group of vscode.window.tabGroups.all) {
        const texts = group.tabs.filter((tab) => tab.input instanceof vscode.TabInputText);
        if (texts.length > 0) await vscode.window.tabGroups.close(texts);
      }
      // VS Code may rebuild the panel's page as it shows it again, leaving the one attached
      // to hidden at the browser's default 300x150. Attach again to the page on screen.
      await openOverview();
      await waitFor(async () => (await evaluate("innerWidth !== 300 || innerHeight !== 150")) === true, "the panel shown again");
      await sleep(300);
      const windowWidth = (await browser.call("Runtime.evaluate", { expression: "innerWidth", returnByValue: true }, pageSession)).result.value;
      const panelWidth = await evaluate("innerWidth");
      const measured: any[] = [];
      try {
        for (const width of [350, 420, 600]) {
          // Other editors beside the panel share what the window loses, so measure and adjust.
          let windowAt = width + windowWidth - panelWidth;
          for (let attempt = 0; attempt < 6; attempt++) {
            await browser.call("Emulation.setDeviceMetricsOverride", { width: windowAt, height: 800, deviceScaleFactor: 1, mobile: false }, pageSession);
            await sleep(400);
            const now = await evaluate("innerWidth");
            if (Math.abs(now - width) <= 2) break;
            windowAt += width - now;
          }
          console.log("narrow panel", width, "->", await evaluate("innerWidth"), "window", windowAt);
          await sleep(300);
          measured.push(await evaluate(`(() => {
            const columns = [...document.querySelectorAll("[data-overview-canvas] > section")].map((column) => column.getBoundingClientRect());
            const boxes = [...document.querySelectorAll("[data-overview-item]")].map((box) => box.getBoundingClientRect());
            const header = document.querySelector("header");
            return {
              width: innerWidth,
              stacked: columns.length === 2 && columns[1].top >= columns[0].bottom,
              lines: document.querySelectorAll("[data-overview-link]").length,
              sideways: document.scrollingElement.scrollWidth > innerWidth || [...document.querySelectorAll("[data-overview-canvas]")].some((el) => el.scrollWidth > el.clientWidth + 1),
              boxesInside: boxes.every((box) => box.left >= 0 && box.right <= innerWidth),
              narrowestBox: Math.round(Math.min(...boxes.map((box) => box.width))),
              headerFits: header.scrollWidth <= header.clientWidth + 1,
            };
          })()`));
          await screenshot(`overview-narrow-${width}`);
        }
      } finally {
        await browser.call("Emulation.clearDeviceMetricsOverride", {}, pageSession);
        await browser.call("Target.detachFromTarget", { sessionId: pageSession });
      }
      assert.deepEqual(measured.map((shown) => shown.width), [350, 420, 600], "the panel reached each width");
      for (const shown of measured) {
        assert.deepEqual(
          { stacked: shown.stacked, lines: shown.lines, sideways: shown.sideways, boxesInside: shown.boxesInside, headerFits: shown.headerFits },
          { stacked: true, lines: 0, sideways: false, boxesInside: true, headerFits: true },
          `at ${shown.width}px: ${JSON.stringify(shown)}`,
        );
        assert.ok(shown.narrowestBox >= 200, `boxes stay readable at ${shown.width}px: ${JSON.stringify(shown)}`);
      }
    });

    it("in a short panel, the details never push the overview out of view", async () => {
      const { targetInfos } = await browser.call("Target.getTargets");
      const page = targetInfos.find((item: any) => item.type === "page" && item.url.includes("workbench"));
      const { sessionId: pageSession } = await browser.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      // A text editor opened by an earlier test covers the panel and would take the room it needs.
      for (const group of vscode.window.tabGroups.all) {
        const texts = group.tabs.filter((tab) => tab.input instanceof vscode.TabInputText);
        if (texts.length > 0) await vscode.window.tabGroups.close(texts);
      }
      // VS Code may rebuild the panel's page as it shows it again, leaving the one attached
      // to hidden at the browser's default 300x150. Attach again to the page on screen.
      await openOverview();
      await waitFor(async () => (await evaluate("innerWidth !== 300 || innerHeight !== 150")) === true, "the panel shown again");
      await sleep(300);
      await click(CLUSTER);
      await waitFor(async () => (await read()).details === CLUSTER, "the cluster's details");
      const window = (await browser.call("Runtime.evaluate", { expression: "({ width: innerWidth, height: innerHeight })", returnByValue: true }, pageSession)).result.value;
      const panelHeight = await evaluate("innerHeight");
      const target = 200;
      let shown: any;
      try {
        // A panel 200px tall, as with the Problems panel open below a small editor. Other
        // parts of the window share what it loses, so measure and adjust.
        let windowHeight = target + window.height - panelHeight;
        for (let attempt = 0; attempt < 6; attempt++) {
          await browser.call("Emulation.setDeviceMetricsOverride", { width: window.width, height: windowHeight, deviceScaleFactor: 1, mobile: false }, pageSession);
          await sleep(400);
          const now = await evaluate("innerHeight");
          if (Math.abs(now - target) <= 2) break;
          windowHeight += target - now;
        }
        await sleep(300);
        shown = await evaluate(`(() => {
          const scroller = document.querySelector("[data-overview-scroller]");
          const details = document.querySelector("[data-overview-details]").getBoundingClientRect();
          return { height: innerHeight, overview: scroller.clientHeight, detailsBottom: Math.round(details.bottom), detailsHeight: Math.round(details.height) };
        })()`);
        await screenshot("overview-short-selected");
      } finally {
        await browser.call("Emulation.clearDeviceMetricsOverride", {}, pageSession);
        await browser.call("Target.detachFromTarget", { sessionId: pageSession });
        await click(CLUSTER);
      }
      assert.ok(Math.abs(shown.height - target) <= 2, `the panel reached ${target}px tall: ${JSON.stringify(shown)}`);
      assert.ok(shown.overview >= 40, `part of the overview stays in view: ${JSON.stringify(shown)}`);
      assert.ok(shown.detailsBottom <= shown.height + 1, `the details stay inside the panel: ${JSON.stringify(shown)}`);
    });
  });
}

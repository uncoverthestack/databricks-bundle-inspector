import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
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

const PIPELINE = "resources.pipelines.orders_etl";

/** What the data flow shows: its boxes, lines, the could-not-read box and the not-read note. */
const READ = `(() => {
  const nodes = [...document.querySelectorAll("[data-data-flow-node]")].map((node) => ({
    id: node.dataset.dataFlowNode,
    kind: node.dataset.dataFlowKind,
    faded: Number(getComputedStyle(node).opacity) < 1,
    dashed: getComputedStyle(node).borderTopStyle === "dashed",
  }));
  return {
    nodes,
    links: [...document.querySelectorAll("[data-data-flow-link]")].map((link) => link.dataset.dataFlowLink),
    unread: document.querySelector("[data-data-flow-unread]")?.innerText ?? null,
    notRead: document.querySelector("[data-data-flow-not-read]")?.textContent ?? null,
  };
})()`;

/**
 * A pipeline's data flow, read from its SQL (issue 398), in the real panel: the lines are
 * measured from the boxes on screen, and the file links open VS Code editors.
 */
export function pipelineFlowSuite() {
  describe("pipeline data flow", function () {
    this.timeout(120_000);
    let browser: Browser;
    let sessionId = "";
    let contextId = 0;
    let sizer: PanelSizer;
    const shots = path.resolve(__dirname, "../pipeline-flow");

    const evaluate = async (expression: string) => {
      const result = await browser.call("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId);
      assert.ok(!result.exceptionDetails, `data flow script must run: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result?.value;
    };
    const read = () => evaluate(READ) as Promise<{
      nodes: { id: string; kind: string; faded: boolean; dashed: boolean }[];
      links: string[];
      unread: string | null;
      notRead: string | null;
    }>;
    const panelSize = () => evaluate("({ width: innerWidth, height: innerHeight })") as Promise<PanelSize>;

    /** Opens the panel on the overview, attaches to the page on screen, and opens the pipeline. */
    const openPipeline = async () => {
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
            const world = await browser.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dbi-pipeline-flow-test" }, attached.sessionId);
            sessionId = attached.sessionId;
            contextId = world.executionContextId;
            // The overview with the pipeline's Open link, or the pipeline already open (a panel
            // brought back to the front keeps its place); not a hidden copy at 300x150.
            if (await evaluate(`(Boolean(document.querySelector('[data-overview-open="${PIPELINE}"]')) || Boolean(document.querySelector("[data-pipeline-data-flow]"))) && !(innerWidth === 300 && innerHeight === 150)`)) return true;
          }
          await browser.call("Target.detachFromTarget", { sessionId: attached.sessionId });
        }
        return false;
      }, "the overview with the pipeline");
      await evaluate(`document.querySelector('[data-overview-open="${PIPELINE}"]')?.click()`);
      await waitFor(async () => (await read()).nodes.length > 0, "the pipeline's data flow");
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
      assert.ok(process.env.E2E_CDP_PORT, "run with npm run test:e2e:pipeline-flow");
      browser = await connectBrowser(process.env.E2E_CDP_PORT);
      await openPipeline();
      sizer = await panelSizer(browser, panelSize);
      await sizer.set(STANDARD_PANEL);
    });

    after(async () => {
      await sizer?.release().catch(() => undefined);
      browser?.close();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    it("shows what the pipeline's SQL creates and reads, with outside sources dashed", async () => {
      await waitFor(async () => (await read()).links.length === 6, "the six reads");
      const shown = await read();
      const kinds = Object.fromEntries(shown.nodes.map((node) => [node.id, node.kind]));
      assert.deepEqual(kinds, {
        "dataset:orders_audit": "materialized_view",
        "dataset:orders_bronze": "streaming_table",
        "dataset:orders_silver": "streaming_table",
        "dataset:orders_by_region": "materialized_view",
        "dataset:orders_by_region_with_a_long_descriptive_name": "materialized_view",
        "outside:main.archive.orders_2024": "outside",
        // The pipeline's configuration fills ${landing} in the file path.
        "files:/Volumes/main/sales/landing/orders": "files",
        "outside:main.reference.regions": "outside",
      });
      for (const node of shown.nodes) {
        assert.equal(node.dashed, node.kind === "outside" || node.kind === "files", `${node.id} is dashed only when outside`);
      }
      assert.deepEqual(shown.links.map((link) => link.slice(0, link.lastIndexOf(":"))).sort(), [
        "dataset:orders_bronze->dataset:orders_silver",
        "dataset:orders_silver->dataset:orders_by_region",
        "dataset:orders_silver->dataset:orders_by_region_with_a_long_descriptive_name",
        "files:/Volumes/main/sales/landing/orders->dataset:orders_bronze",
        "outside:main.archive.orders_2024->dataset:orders_silver",
        "outside:main.reference.regions->dataset:orders_by_region",
      ]);
      assert.match(shown.unread ?? "", /1 name could not be read/);
      assert.match(shown.unread ?? "", /backfill\.sql:6/);
      assert.match(shown.notRead ?? "", /1 Python file is not read yet/);
      // Every table's box shows its type and keeps its name and file link inside it, even
      // with a long name in a file named after it (seen on Databricks' lakeflow example).
      const boxes = await evaluate(`[...document.querySelectorAll("[data-data-flow-node]")].map((node) => {
        const box = node.getBoundingClientRect();
        const kind = node.querySelector("[data-data-flow-kind-words]");
        const link = node.querySelector("[data-data-flow-open]");
        const inside = (el) => !el || (el.getBoundingClientRect().right <= box.right + 1 && el.getBoundingClientRect().left >= box.left - 1);
        return { id: node.dataset.dataFlowNode, kindWidth: kind ? Math.round(kind.getBoundingClientRect().width) : 0, kindText: kind?.textContent ?? "", linkInside: inside(link), link: link?.textContent ?? null, overflow: node.scrollWidth > node.clientWidth + 1 };
      })`);
      for (const box of boxes) {
        assert.equal(box.linkInside, true, `${box.id} keeps its file link inside: ${JSON.stringify(box)}`);
        assert.equal(box.overflow, false, `${box.id} has nothing spilling out: ${JSON.stringify(box)}`);
      }
      for (const box of boxes) assert.ok(box.kindWidth > 20 && box.kindText.trim(), `${box.id} shows its type: ${JSON.stringify(box)}`);
      const long = boxes.find((box: any) => box.id === "dataset:orders_by_region_with_a_long_descriptive_name");
      assert.equal(long?.link, "line 3", "a file named after its table links as just its line");
      // The table whose only read could not be read says so on its own box.
      assert.match(await evaluate(`document.querySelector('[data-data-flow-node="dataset:orders_audit"] [data-data-flow-unread-into]')?.textContent ?? ""`), /^1 read could not be read$/);
      await screenshot("pipeline-flow");
    });

    it("pointing at a table lights what it reads and what reads it, and fades the rest", async () => {
      const spot = await evaluate(`(() => { const r = document.querySelector('[data-data-flow-node="dataset:orders_silver"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y }, sessionId);
      await waitFor(async () => (await read()).nodes.some((node) => node.faded), "the others to fade");
      const faded = (await read()).nodes.filter((node) => node.faded).map((node) => node.id).sort();
      assert.deepEqual(faded, ["dataset:orders_audit", "files:/Volumes/main/sales/landing/orders", "outside:main.reference.regions"]);
      await screenshot("pipeline-flow-active");
      await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
      await evaluate(`document.querySelector("[data-data-flow-canvas]").dispatchEvent(new MouseEvent("mouseleave"))`);
      await waitFor(async () => (await read()).nodes.every((node) => !node.faded), "nothing faded");
    });

    it("a table's file link opens the SQL on the line that creates it", async () => {
      await evaluate(`document.querySelector('[data-data-flow-open="dataset:orders_by_region"]').click()`);
      await waitFor(async () => {
        const editor = vscode.window.activeTextEditor;
        return Boolean(editor?.document.fileName.endsWith("silver.sql")) &&
          editor!.document.lineAt(editor!.selection.active.line).text.includes("orders_by_region");
      }, "silver.sql on the orders_by_region line");
    });

    it("a narrow panel scrolls the data flow inside itself, never the page", async () => {
      // The file link above opened an editor over the panel; bring the panel back.
      for (const group of vscode.window.tabGroups.all) {
        const texts = group.tabs.filter((tab) => tab.input instanceof vscode.TabInputText);
        if (texts.length > 0) await vscode.window.tabGroups.close(texts);
      }
      await openPipeline();
      let shown: any;
      try {
        await sizer.set({ width: 420, height: STANDARD_PANEL.height });
        await sleep(300);
        shown = await evaluate(`(() => {
          const canvas = document.querySelector("[data-data-flow-canvas]");
          return { width: innerWidth, page: document.scrollingElement.scrollWidth, canvasScrolls: canvas.scrollWidth > canvas.clientWidth };
        })()`);
        await screenshot("pipeline-flow-narrow");
        // Cut-off boxes are counted at the edge (issue 550), and the count goes once scrolled to the end.
        const more = () => evaluate(`Number(document.querySelector("[data-data-flow-more]")?.dataset.dataFlowMore ?? 0)`);
        shown.more = await more();
        await evaluate(`(() => { const canvas = document.querySelector("[data-data-flow-canvas]"); canvas.scrollLeft = canvas.scrollWidth; })()`);
        await waitFor(async () => (await more()) === 0, "no count after scrolling to the end");
      } finally {
        await sizer.set(STANDARD_PANEL);
      }
      assert.ok(shown.page <= shown.width + 1, `no sideways page scroll: ${JSON.stringify(shown)}`);
      assert.equal(shown.canvasScrolls, true, `the data flow scrolls inside itself: ${JSON.stringify(shown)}`);
      assert.ok(shown.more > 0, `the cut-off boxes are counted: ${JSON.stringify(shown)}`);
      await waitFor(async () => !(await evaluate(`Boolean(document.querySelector("[data-data-flow-more]"))`)), "no count at the standard width");
    });

    it("a save that removes the focused table leaves no box faded and no stale scroll width", async () => {
      // The narrow-panel test before this one left the panel on the pipeline; make sure.
      await openPipeline();
      await sizer.set(STANDARD_PANEL);
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      const dir = path.join(root, "src/transformations");
      const files = ["backfill.sql", "silver.sql", "orders_by_region_with_a_long_descriptive_name.sql"].map((name) => vscode.Uri.file(path.join(dir, name)));
      const original = await Promise.all(files.map(async (file) => Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8")));
      await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
      try {
        await evaluate(`document.querySelector('[data-data-flow-node="dataset:orders_audit"]').focus()`);
        await waitFor(async () => (await read()).nodes.some((node) => node.faded), "the focused table lighting its links");
        // Keep only bronze and silver: orders_audit (focused), the flow and the later tables go.
        await vscode.workspace.fs.writeFile(files[0]!, Buffer.from("", "utf8"));
        await vscode.workspace.fs.writeFile(files[1]!, Buffer.from("CREATE OR REFRESH STREAMING TABLE orders_silver\nAS SELECT * FROM STREAM(orders_bronze);\n", "utf8"));
        await vscode.workspace.fs.writeFile(files[2]!, Buffer.from("", "utf8"));
        await waitFor(async () => (await read()).nodes.length === 3, "the smaller data flow after the save");
        await sleep(400);
        const shown = await read();
        assert.deepEqual(shown.nodes.filter((node) => node.faded).map((node) => node.id), [], "no box fades for a table that is gone");
        const widths = await evaluate(`(() => {
          const canvas = document.querySelector("[data-data-flow-canvas]");
          const row = canvas.querySelector(":scope > div");
          const svg = canvas.querySelector("svg");
          return { canvasScroll: canvas.scrollWidth, canvasClient: canvas.clientWidth, row: row.offsetWidth, svg: svg.getBoundingClientRect().width };
        })()`);
        const needed = Math.max(widths.canvasClient, widths.row + 32);
        assert.ok(widths.canvasScroll <= needed + 2, `no stale scroll width after shrinking: ${JSON.stringify(widths)}`);
      } finally {
        // A disappearing debugger session must not leave the tracked fixture edited.
        try {
          await browser.call("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId);
        } finally {
          for (let i = 0; i < files.length; i++) await vscode.workspace.fs.writeFile(files[i]!, Buffer.from(original[i]!, "utf8"));
        }
        await waitFor(async () => (await read()).nodes.length === 8, "the full data flow again");
      }
    });

    it("the overview's side panel holds the pipeline's details, and opens its data flow (#436)", async () => {
      const picker = `document.querySelector('header select:not([aria-label="Target"])')`;
      const details = (key: string) => `document.querySelector('[data-pipeline-details="${key}"]')`;
      // Back from the data flow page: the overview, with the pipeline that was open selected.
      await evaluate(`document.querySelector("[data-back-to-overview]").click()`);
      await waitFor(async () => await evaluate(`Boolean(${details("orders_etl")})`), "orders_etl selected on the overview");
      const shown = await evaluate(`({
        place: ${picker}.value,
        pipelines: [...${picker}.querySelectorAll('optgroup[label="Pipelines"] option')].map(o => [o.value, o.textContent]),
        summary: ${details("orders_etl")}.querySelector('[data-pipeline-data-flow-summary]').innerText,
        opens: Boolean(${details("orders_etl")}.querySelector('[data-pipeline-open-data-flow]')),
        boxLink: document.querySelector('[data-overview-open="${PIPELINE}"]')?.textContent,
        pythonBoxLink: Boolean(document.querySelector('[data-overview-open="resources.pipelines.scores_py"]')),
      })`);
      assert.equal(shown.place, "overview");
      // Only the pipeline with SQL sources has a page, listed as its data flow.
      assert.deepEqual(shown.pipelines, [["pipelines:orders_etl", "orders_etl · data flow"]]);
      // 5 tables and views; 2 tables and 1 file path from outside.
      assert.match(shown.summary, /Creates 5 tables and views, reads 3 from outside\./);
      assert.equal(shown.opens, true);
      assert.equal(shown.boxLink, "Data flow ›");
      assert.equal(shown.pythonBoxLink, false, "a Python-only pipeline's box has no link");
      await screenshot("pipeline-details");

      // A Python-only pipeline says why it has no data flow, and offers none.
      await evaluate(`document.querySelector('[data-overview-item="resources.pipelines.scores_py"]').click()`);
      await waitFor(async () => await evaluate(`Boolean(${details("scores_py")})`), "scores_py's details");
      assert.match(await evaluate(`${details("scores_py")}.querySelector('[data-pipeline-data-flow-summary]').innerText`), /From SQL sources only\. This pipeline's are Python\./);
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-pipeline-open-data-flow]'))`), false);

      // The details' button opens the data flow page, and Copy review there describes the pipeline.
      await evaluate(`document.querySelector('[data-overview-item="${PIPELINE}"]').click()`);
      await waitFor(async () => await evaluate(`Boolean(document.querySelector('[data-pipeline-open-data-flow]'))`), "orders_etl's details again");
      await evaluate(`document.querySelector('[data-pipeline-open-data-flow]').click()`);
      await waitFor(async () => await evaluate(`${picker}.value === "pipelines:orders_etl" && Boolean(document.querySelector('[data-data-flow-page="orders_etl"]'))`), "the data flow page");
      await vscode.env.clipboard.writeText("");
      await evaluate(`[...document.querySelectorAll('header button')].find(b => b.textContent.includes('Copy review')).click()`);
      await waitFor(async () => (await vscode.env.clipboard.readText()).includes("Pipeline: orders\\_etl"), "the copied pipeline review");
    });

    it("a self-read has a visible loop above its box (#607)", async () => {
      await openPipeline();
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      const file = path.join(root, "src/transformations/self-read.sql");
      try {
        await writeFile(file, "CREATE MATERIALIZED VIEW self_read AS SELECT * FROM self_read;\n");
        const link = '[data-data-flow-link="dataset:self_read->dataset:self_read:"]';
        await waitFor(async () => await evaluate(`Boolean(document.querySelector('${link}'))`), "the self-read line after saving");
        const height = await evaluate(`document.querySelector('${link}').getBBox().height`);
        assert.ok(height > 10, `a self-read bends outside its box instead of hiding behind it: ${height}`);
        await screenshot("pipeline-self-read");
      } finally {
        await unlink(file);
        await waitFor(async () => (await read()).nodes.length === 8, "the original data flow after removing the self-read");
      }
    });

    it("a long file name in the could-not-read list never scrolls a narrow panel sideways", async () => {
      let shown: any;
      try {
        await sizer.set({ width: 350, height: STANDARD_PANEL.height });
        await sleep(300);
        shown = await evaluate(`(() => {
          const link = document.querySelector("[data-data-flow-unread] button span");
          link.textContent = "${"a".repeat(160)}.sql:6";
          const list = document.querySelector("[data-data-flow-unread]");
          return { width: innerWidth, page: document.scrollingElement.scrollWidth, list: list.scrollWidth, room: list.clientWidth };
        })()`);
      } finally {
        await sizer.set(STANDARD_PANEL);
      }
      assert.ok(shown.page <= shown.width + 1 && shown.list <= shown.room + 1, `no sideways scroll: ${JSON.stringify(shown)}`);
    });
    it("hidden SQL follows the upload rules in the rendered data flow", async () => {
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      const source = path.join(root, "src/transformations/.source-coverage.sql");
      const bundle = path.join(root, "databricks.yml");
      const gitignore = path.join(root, ".gitignore");
      const originalBundle = readFileSync(bundle, "utf8");
      const originalIgnore = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : undefined;
      const present = async () => (await read()).nodes.some(node => node.id === "dataset:source_coverage_probe");
      try {
        writeFileSync(source, "CREATE MATERIALIZED VIEW source_coverage_probe AS SELECT 1 AS id;\n");
        await openPipeline();
        await waitFor(present, "the uploaded hidden SQL definition");
        await screenshot("pipeline-hidden-source");

        writeFileSync(bundle, originalBundle + "\nsync:\n  exclude: [src/transformations/.source-coverage.sql]\n");
        await openPipeline();
        await waitFor(async () => !(await present()), "the excluded hidden definition to disappear");

        writeFileSync(bundle, originalBundle);
        writeFileSync(gitignore, (originalIgnore ?? "") + "\nsrc/transformations/.source-coverage.sql\n");
        await openPipeline();
        await waitFor(async () => !(await present()), "the gitignored definition to stay out");

        if (originalIgnore === undefined) rmSync(gitignore); else writeFileSync(gitignore, originalIgnore);
        await openPipeline();
        await waitFor(present, "the restored hidden source");
      } finally {
        writeFileSync(bundle, originalBundle);
        if (originalIgnore === undefined) rmSync(gitignore, { force: true }); else writeFileSync(gitignore, originalIgnore);
        rmSync(source, { force: true });
        await openPipeline();
      }
    });

    it("an unreadable source folder shows an incomplete-flow notice and a YAML error", async function () {
      if (process.platform === "win32" || process.getuid?.() === 0) this.skip();
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      const denied = path.join(root, "src/transformations/source-coverage-denied");
      const yaml = vscode.Uri.file(path.join(root, "resources/orders.pipeline.yml"));
      try {
        mkdirSync(denied);
        writeFileSync(path.join(denied, "probe.sql"), "CREATE MATERIALIZED VIEW source_coverage_denied AS SELECT 1 AS id;\n");
        chmodSync(denied, 0);
        await openPipeline();
        await waitFor(async () => Boolean(await evaluate('document.querySelector("[data-data-flow-incomplete]")')), "the incomplete-data-flow notice");
        assert.match(await evaluate('document.querySelector("[data-data-flow-incomplete]").textContent'), /incomplete/);
        await waitFor(async () => vscode.languages.getDiagnostics(yaml).some(diagnostic =>
          (typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code) === "file_scan_failed" &&
          diagnostic.severity === vscode.DiagnosticSeverity.Error), "the source scan error at the pipeline YAML");
        await screenshot("pipeline-unreadable-source-folder");
      } finally {
        if (existsSync(denied)) chmodSync(denied, 0o755);
        rmSync(denied, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        await openPipeline();
      }
      await waitFor(async () => !(await evaluate('document.querySelector("[data-data-flow-incomplete]")')), "the notice to clear after a successful retry");
    });

  });
}

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { connectBrowser } from "./browser.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const jobSelector = 'header select:not([aria-label="Target"])';

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** No check running or waiting to start. */
async function idle(): Promise<void> {
  await waitFor(
    async () =>
      !(await vscode.commands.executeCommand<{ checksPending: boolean }>("databricksBundleInspector.test.statusBar"))!.checksPending,
    "the checks to finish",
  );
}

export function graphRefreshSuite() {
  describe("rendered graph after refreshing", function () {
    this.timeout(120_000);

    it("keeps a user-selected job through saves after opening Issues and refreshing the preview", async function () {
      assert.ok(process.env.E2E_CDP_PORT, "run with npm run test:e2e:graph-refresh");
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      const config = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "alpha/databricks.yml")));
      await vscode.window.showTextDocument(config);
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "alpha/resources/jobs.yml")));
      const original = document.getText();
      const line = original.split(/\r?\n/).findIndex(text => text.includes("name: alpha_second"));
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      await vscode.commands.executeCommand("databricksBundleInspector.openBundleIssues");

      const browser = await connectBrowser(process.env.E2E_CDP_PORT);
      let graph: { sessionId: string; contextId: number } | undefined;
      const select = `document.querySelector(${JSON.stringify(jobSelector)})`;
      const evaluate = async (expression: string, sessionId: string, contextId: number) => {
        const result = await browser.call("Runtime.evaluate", { expression, contextId, returnByValue: true }, sessionId);
        assert.ok(!result.exceptionDetails, "graph script must execute");
        return result.result?.value;
      };
      try {
        await waitFor(async () => {
          const { targetInfos } = await browser.call("Target.getTargets");
          for (const target of targetInfos.filter((item: any) => item.type === "iframe" && item.url.startsWith("vscode-webview://"))) {
            const { sessionId } = await browser.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
            const { frameTree } = await browser.call("Page.getFrameTree", {}, sessionId);
            const frames: any[] = [];
            const visit = (node: any) => { frames.push(node.frame); for (const child of node.childFrames ?? []) visit(child); };
            visit(frameTree);
            for (const frame of frames) {
              const { executionContextId } = await browser.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dbi-graph-test" }, sessionId);
              if (await evaluate(`${select}?.value`, sessionId, executionContextId) === "jobs:alpha_second") {
                graph = { sessionId, contextId: executionContextId };
                return true;
              }
            }
            await browser.call("Target.detachFromTarget", { sessionId });
          }
          return false;
        }, "the rendered job dropdown");
        assert.ok(graph);
        // #335: controls must remain usable, not just present, below the 768px breakpoint.
        const { targetInfos: windowTargets } = await browser.call("Target.getTargets");
        const windowPage = windowTargets.find((target: any) => target.type === "page");
        assert.ok(windowPage);
        const { sessionId: windowSession } = await browser.call("Target.attachToTarget", { targetId: windowPage.targetId, flatten: true });
        const originalWidth = await evaluate("innerWidth", graph.sessionId, graph.contextId);
        const windowWidth = (await browser.call("Runtime.evaluate", { expression: "innerWidth", returnByValue: true }, windowSession)).result.value;
        const measurements = [];
        try {
          for (const width of [350, 400, 600, 767, 768]) {
            await browser.call("Emulation.setDeviceMetricsOverride", { width: width + windowWidth - originalWidth, height: 800, deviceScaleFactor: 1, mobile: false }, windowSession);
            await waitFor(async () => Math.abs(await evaluate("innerWidth", graph!.sessionId, graph!.contextId) - width) <= 2, `a ${width}px graph`);
            measurements.push(await evaluate(`(() => {
              const target = document.querySelector('header select[aria-label="Target"]').getBoundingClientRect();
              const copy = document.querySelector('header button[aria-label="Copy review"]').getBoundingClientRect();
              return { width: innerWidth, targetWidth: target.width, copyWidth: copy.width, copyRight: copy.right, scrollWidth: document.scrollingElement.scrollWidth };
            })()`, graph.sessionId, graph.contextId));
          }
        } finally {
          await browser.call("Emulation.clearDeviceMetricsOverride", {}, windowSession);
          await browser.call("Target.detachFromTarget", { sessionId: windowSession });
        }
        for (const measurement of measurements) {
          assert.ok(measurement.targetWidth >= 24, `target picker remains usable: ${JSON.stringify(measurement)}`);
          assert.ok(measurement.copyWidth >= 24 && measurement.copyRight <= measurement.width, `Copy review remains visible: ${JSON.stringify(measurement)}`);
          assert.ok(measurement.scrollWidth <= measurement.width, `no horizontal page overflow: ${JSON.stringify(measurement)}`);
        }
        await waitFor(async () => await evaluate("innerWidth", graph!.sessionId, graph!.contextId) === originalWidth, "the original graph width");
        const issuesOpen = `Boolean(document.querySelector('button[aria-label="Close Issues in This Job"]'))`;
        assert.equal(await evaluate(issuesOpen, graph.sessionId, graph.contextId), true);
        await evaluate(`(()=>{const s=${select};s.value='jobs:alpha_first';s.dispatchEvent(new Event('change',{bubbles:true}));})()`, graph.sessionId, graph.contextId);
        await waitFor(async () => await evaluate(`${select}?.value`, graph!.sessionId, graph!.contextId) === "jobs:alpha_first", "the user's job selection");
        // Choosing a job closes the panel. Reopen it through the actual Issues button.
        await evaluate(`[...document.querySelectorAll('header button')].find(button => button.textContent.trim().startsWith('Issues'))?.click()`, graph.sessionId, graph.contextId);
        await waitFor(async () => await evaluate(issuesOpen, graph!.sessionId, graph!.contextId) === true, "the reopened Issues panel");

        for (let round = 0; round < 3; round++) {
          const name = `alpha_first_refresh_${round}`;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), original.replace("name: alpha_first", `name: ${name}`));
          await vscode.workspace.applyEdit(edit);
          await document.save();
          await waitFor(async () => {
            const data = await vscode.commands.executeCommand<any>("databricksBundleInspector.test.graphData");
            return data?.parsedBundle?.resources?.jobs?.alpha_first?.name === name;
          }, "the saved data reaching the graph");
          // Let React commit the posted refresh before reading the actual dropdown.
          await sleep(200);
          assert.equal(await evaluate(`${select}?.value`, graph.sessionId, graph.contextId), "jobs:alpha_first", `selection after save ${round + 1}`);
          assert.equal(await evaluate(issuesOpen, graph.sessionId, graph.contextId), true, "save keeps the Issues panel open");
        }
        await vscode.commands.executeCommand("databricksBundleInspector.test.selectTarget", undefined);
        await sleep(200);
        assert.equal(await evaluate(`${select}?.value`, graph.sessionId, graph.contextId), "jobs:alpha_first", "selection after refreshing the structural preview");

        const reopened = await vscode.window.showTextDocument(document);
        reopened.selection = new vscode.Selection(line, 0, line, 0);
        await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
        await waitFor(async () => await evaluate(`${select}?.value`, graph!.sessionId, graph!.contextId) === "jobs:alpha_second", "a fresh Inspect request selecting the job under the cursor");
        const requested = await vscode.commands.executeCommand<any>("databricksBundleInspector.test.graphData");
        assert.equal(requested.preserveView, false, "a new inspection is distinct from a refresh");
        assert.equal(await evaluate(issuesOpen, graph.sessionId, graph.contextId), false, "a fresh Inspect request returns to the normal view");
      } finally {
        browser.close();
        const restore = new vscode.WorkspaceEdit();
        restore.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), original);
        await vscode.workspace.applyEdit(restore);
        await document.save();
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });

    it("opens on the pipeline under the cursor, and the picker switches between it and a job", async function () {
      assert.ok(process.env.E2E_CDP_PORT, "run with npm run test:e2e:graph-refresh");
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      // As in the next test: the previous test's close must not close the graph this one opens.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitFor(
        async () => !vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview)),
        "the previous graph to close",
      );
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "alpha/resources/jobs.yml")));
      const line = document.getText().split(/\r?\n/).findIndex(text => text.includes("name: alpha_pipeline"));
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      // The previous test's saves start checks. One landing as the graph opens would show the
      // preview without the pipeline to start on (#288, as #275 was for the include test).
      await idle();
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");

      const browser = await connectBrowser(process.env.E2E_CDP_PORT);
      try {
        let graph: { sessionId: string; contextId: number } | undefined;
        const evaluate = async (expression: string) => {
          const result = await browser.call("Runtime.evaluate", { expression, contextId: graph!.contextId, returnByValue: true }, graph!.sessionId);
          assert.ok(!result.exceptionDetails, "graph script must execute");
          return result.result?.value;
        };
        const select = `document.querySelector(${JSON.stringify(jobSelector)})`;
        const details = `document.querySelector('[aria-label="Pipeline details"]')`;
        await waitFor(async () => {
          const { targetInfos } = await browser.call("Target.getTargets");
          for (const target of targetInfos.filter((item: any) => item.type === "iframe" && item.url.startsWith("vscode-webview://"))) {
            const { sessionId } = await browser.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
            const { frameTree } = await browser.call("Page.getFrameTree", {}, sessionId);
            const frames: any[] = [];
            const visit = (node: any) => { frames.push(node.frame); for (const child of node.childFrames ?? []) visit(child); };
            visit(frameTree);
            for (const frame of frames) {
              const { executionContextId } = await browser.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dbi-pipeline-test" }, sessionId);
              graph = { sessionId, contextId: executionContextId };
              if (await evaluate(`${select}?.value`) === "pipelines:alpha_pipeline" && await evaluate(`Boolean(${details})`)) return true;
            }
            await browser.call("Target.detachFromTarget", { sessionId });
          }
          return false;
        }, "the pipeline view");

        const shown = await evaluate(`({
          groups: [...${select}.querySelectorAll('optgroup')].map(g => [g.label, [...g.querySelectorAll('option')].map(o => o.value)]),
          name: ${details}.querySelector('.text-lg')?.textContent,
          sources: [...document.querySelectorAll('[aria-label="Sources"] li')].map(li => li.textContent),
          defaultSchema: document.querySelector('[aria-label="Default catalog and schema"]')?.textContent,
          search: Boolean(document.querySelector('header input')),
          taskGraph: Boolean(document.querySelector('.react-flow')),
        })`);
        assert.deepEqual(shown.groups, [
          // alpha also includes the sales team's resource file.
          ["Jobs", ["jobs:alpha_first", "jobs:alpha_second", "jobs:sales_first", "jobs:sales_second"]],
          ["Pipelines", ["pipelines:alpha_pipeline"]],
        ]);
        assert.equal(shown.name, "alpha_pipeline");
        assert.equal(shown.sources.length, 2);
        assert.match(shown.sources[0], /notebook\.\.\/src\/task\.pyjobs\.yml:\d+Found/);
        assert.match(shown.sources[1], /file\.\.\/src\/task\.pyjobs\.yml:\d+Is a notebook/);

        // Copy review describes this pipeline, not a job, and only its own problems.
        await vscode.env.clipboard.writeText("");
        await evaluate(`[...document.querySelectorAll('header button')].find(b => b.textContent.includes('Copy review')).click()`);
        await waitFor(async () => (await vscode.env.clipboard.readText()).includes("Pipeline: alpha_pipeline"), "the copied pipeline review");
        const review = await vscode.env.clipboard.readText();
        assert.doesNotMatch(review, /Job:|Selected job|file references/);
        // Its one problem, the notebook listed as a file, and none of the bundle's other issues.
        assert.match(review, /### Issues\n- \*\*Error\*\* · "\.\.\/src\/task\.py" may be a notebook, not a file\. \(jobs\.yml:\d+\)\n\n### Run by/);
        assert.match(review, /### Run by\n- alpha_second \(task refresh\)\n- alpha_second \(task refresh_each\)/);
        assert.match(review, /- 2 sources in libraries\n- 1 found\n- 1 a notebook listed as a file/);

        // A narrow editor keeps the source paths readable. Resizing the webview itself leaves
        // it 0px wide, so narrow the VS Code window by what it keeps beside the graph.
        const { targetInfos } = await browser.call("Target.getTargets");
        const workbench = targetInfos.find((item: any) => item.type === "page" && item.url.includes("workbench"));
        assert.ok(workbench, "the VS Code window");
        const { sessionId: windowSession } = await browser.call("Target.attachToTarget", { targetId: workbench.targetId, flatten: true });
        const windowWidth = async () =>
          (await browser.call("Runtime.evaluate", { expression: "window.innerWidth", returnByValue: true }, windowSession)).result.value;
        const fullWidth = await evaluate("window.innerWidth");
        try {
          const besideGraph = (await windowWidth()) - fullWidth;
          await browser.call("Emulation.setDeviceMetricsOverride", { width: 350 + besideGraph, height: 800, deviceScaleFactor: 1, mobile: false }, windowSession);
          await waitFor(async () => Math.abs(await evaluate("window.innerWidth") - 350) <= 2, "a 350px graph");
          const narrow = await evaluate(`({
            width: window.innerWidth,
            paths: [...document.querySelectorAll('[aria-label="Sources"] li')].map(li => li.children[1].getBoundingClientRect().width),
            sideways: document.scrollingElement.scrollWidth > window.innerWidth,
          })`);
          assert.equal(narrow.paths.length, 2);
          for (const width of narrow.paths) assert.ok(width > 100, `source path width at ${narrow.width}px: ${width}`);
          assert.equal(narrow.sideways, false, `no sideways scroll at ${narrow.width}px`);
        } finally {
          await browser.call("Emulation.clearDeviceMetricsOverride", {}, windowSession);
          await browser.call("Target.detachFromTarget", { sessionId: windowSession });
        }
        await waitFor(async () => await evaluate("window.innerWidth") === fullWidth, "the graph's full width again");
        assert.match(shown.defaultSchema, /main\.alpha/);
        assert.equal(shown.search, false, "search works on tasks, so it stands aside for a pipeline");
        assert.equal(shown.taskGraph, false);

        await evaluate(`(()=>{const s=${select};s.value='jobs:alpha_first';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(async () => await evaluate(`Boolean(document.querySelector('.react-flow')) && !${details}`) === true, "the job's task graph");
        assert.equal(await evaluate(`Boolean(document.querySelector('header input'))`), true, "search is back for a job");

        // A pipeline task's Pipeline row leads back to its pipeline.
        await evaluate(`(()=>{const s=${select};s.value='jobs:alpha_second';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        const taskNode = (key: string) => `document.querySelector('.react-flow__node[data-id$=".tasks.${key}"]')`;
        await waitFor(async () => await evaluate(`Boolean(${taskNode("refresh")})`) === true, "the pipeline task");
        await evaluate(`${taskNode("refresh")}.click()`);
        const pipelineRow = `[...document.querySelectorAll('[title$="Click to show the pipeline."]')]`;
        await waitFor(async () => await evaluate(`${pipelineRow}.length === 1 && ${pipelineRow}[0].textContent.includes('alpha_pipeline')`) === true, "the task's Pipeline row");
        await evaluate(`${pipelineRow}[0].click()`);
        await waitFor(async () => await evaluate(`${select}.value === 'pipelines:alpha_pipeline' && Boolean(${details})`) === true, "the pipeline view again");
        assert.match(await evaluate(`document.querySelector('[aria-label="Run by"]').textContent`), /alpha_second.*task refresh/);

        // A pipeline task inside for_each_task leads to its pipeline too, from a row of its own.
        await evaluate(`(()=>{const s=${select};s.value='jobs:alpha_second';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(async () => await evaluate(`Boolean(${taskNode("refresh_each")})`) === true, "the loop task");
        await evaluate(`${taskNode("refresh_each")}.click()`);
        await waitFor(async () => await evaluate(`${pipelineRow}.length === 1 && ${pipelineRow}[0].textContent.includes('alpha_pipeline')`) === true, "the loop's Pipeline row");
        await evaluate(`${pipelineRow}[0].click()`);
        await waitFor(async () => await evaluate(`${select}.value === 'pipelines:alpha_pipeline' && Boolean(${details})`) === true, "the pipeline view from the loop");

        // A job's Copy review is a menu; Full report adds the task graph, built by the extension.
        await evaluate(`(()=>{const s=${select};s.value='jobs:alpha_second';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(async () => await evaluate(`Boolean(${taskNode("refresh_each")})`) === true, "alpha_second's graph");
        await vscode.env.clipboard.writeText("");
        await evaluate(`[...document.querySelectorAll('header button')].find(b => b.textContent.includes('Copy review')).click()`);
        await waitFor(async () => await evaluate(`document.querySelectorAll('[role="menuitem"]').length`) === 2, "the Copy review menu");
        assert.equal(
          await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].every(b => [...b.querySelectorAll('span')].some(s => s.textContent.trim() === 'Markdown'))`),
          true,
          "each Copy review item says it copies Markdown",
        );
        await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.startsWith('Full report')).click()`);
        await waitFor(async () => (await vscode.env.clipboard.readText()).includes("## Databricks Bundle Review: alpha_second"), "the copied full report");
        const report = await vscode.env.clipboard.readText();
        assert.match(report, /\| Databricks CLI \| \d+\.\d+\.\d+ \|/);
        assert.match(report, /\| Databricks Bundle Inspector \| \d+\.\d+\.\d+ \|/);
        assert.match(report, /```mermaid\nflowchart LR\n/);
        assert.match(report, /t2\(\["<b>refresh<\/b><br\/>Pipeline"\]\)/);
        assert.match(report, /subgraph t3\["refresh_each · for each of \[1, 2\]"\]/);
        assert.match(report, /t1 --> t2\n {2}t2 --> t3/);
        assert.equal(await evaluate(`document.querySelectorAll('[role="menuitem"]').length`), 0, "the menu closes");
      } finally {
        browser.close();
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });

    it("opens on the bundle overview from the bundle file, goes into a job and comes back", async function () {
      assert.ok(process.env.E2E_CDP_PORT, "run with npm run test:e2e:graph-refresh");
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitFor(
        async () => !vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview)),
        "the previous graph to close",
      );
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, "alpha/databricks.yml")));
      await idle();
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");

      const browser = await connectBrowser(process.env.E2E_CDP_PORT);
      try {
        let graph: { sessionId: string; contextId: number } | undefined;
        const evaluate = async (expression: string) => {
          const result = await browser.call("Runtime.evaluate", { expression, contextId: graph!.contextId, returnByValue: true }, graph!.sessionId);
          assert.ok(!result.exceptionDetails, "graph script must execute");
          return result.result?.value;
        };
        const select = `document.querySelector(${JSON.stringify(jobSelector)})`;
        const JOB = "resources.jobs.alpha_second";
        const PIPELINE = "resources.pipelines.alpha_pipeline";
        const read = () => evaluate(`({
          place: ${select}?.value,
          boxes: [...document.querySelectorAll("[data-overview-item]")].map((box) => box.dataset.overviewItem),
          pressed: [...document.querySelectorAll('[data-overview-item][aria-pressed="true"]')].map((box) => box.dataset.overviewItem),
          links: [...document.querySelectorAll("[data-overview-link]")].map((link) => link.dataset.overviewLink),
          back: Boolean(document.querySelector("[data-back-to-overview]")),
          search: document.querySelector("header input")?.placeholder ?? null,
          taskGraph: Boolean(document.querySelector(".react-flow")),
          pipelineDetails: Boolean(document.querySelector('[aria-label="Pipeline details"]')),
        })`);
        await waitFor(async () => {
          const { targetInfos } = await browser.call("Target.getTargets");
          for (const target of targetInfos.filter((item: any) => item.type === "iframe" && item.url.startsWith("vscode-webview://"))) {
            const { sessionId } = await browser.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
            const { frameTree } = await browser.call("Page.getFrameTree", {}, sessionId);
            const frames: any[] = [];
            const visit = (node: any) => { frames.push(node.frame); for (const child of node.childFrames ?? []) visit(child); };
            visit(frameTree);
            for (const frame of frames) {
              const { executionContextId } = await browser.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dbi-overview-place-test" }, sessionId);
              graph = { sessionId, contextId: executionContextId };
              if (await evaluate(`document.querySelectorAll("[data-overview-item]").length`) > 0) return true;
            }
            await browser.call("Target.detachFromTarget", { sessionId });
          }
          return false;
        }, "the bundle overview");

        // The bundle has jobs and a pipeline, and still opens on its overview.
        await waitFor(async () => (await read()).links.includes(`${JOB}->${PIPELINE}`), "the line from the job to the pipeline it runs");
        const opened = await read();
        assert.equal(opened.place, "overview");
        for (const id of ["resources.jobs.alpha_first", JOB, PIPELINE]) assert.ok(opened.boxes.includes(id), `a box for ${id}`);
        assert.deepEqual(
          { pressed: opened.pressed, back: opened.back, search: opened.search, taskGraph: opened.taskGraph },
          { pressed: [], back: false, search: "Find a resource", taskGraph: false },
        );

        // A picture of the overview on a bundle with jobs, for a look by eye. Not compared.
        const { targetInfos: pages } = await browser.call("Target.getTargets");
        const page = pages.find((item: any) => item.type === "page" && item.url.includes("workbench"));
        if (page) {
          const { sessionId: pageSession } = await browser.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
          const { data } = await browser.call("Page.captureScreenshot", { format: "png" }, pageSession);
          const shots = path.resolve(__dirname, "../overview");
          mkdirSync(shots, { recursive: true });
          writeFileSync(path.join(shots, "overview-with-jobs.png"), Buffer.from(data, "base64"));
          await browser.call("Target.detachFromTarget", { sessionId: pageSession });
        }

        // The Open link on a job's box goes to that job's graph.
        await evaluate(`document.querySelector('[data-overview-open="${JOB}"]').click()`);
        await waitFor(async () => { const now = await read(); return now.place === "jobs:alpha_second" && now.taskGraph; }, "alpha_second's graph");
        const inJob = await read();
        assert.deepEqual({ back: inJob.back, search: inJob.search, boxes: inJob.boxes }, { back: true, search: "Search tasks", boxes: [] });

        // The back arrow returns to the overview, with the job that was open selected.
        await evaluate(`document.querySelector("[data-back-to-overview]").click()`);
        await waitFor(async () => (await read()).place === "overview", "the overview again");
        const back = await read();
        assert.deepEqual({ pressed: back.pressed, taskGraph: back.taskGraph, back: back.back }, { pressed: [JOB], taskGraph: false, back: false });

        // The picker goes to a pipeline and back to the overview too.
        await evaluate(`(()=>{const s=${select};s.value='pipelines:alpha_pipeline';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(async () => (await read()).pipelineDetails, "the pipeline view");
        await evaluate(`(()=>{const s=${select};s.value='overview';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(async () => { const now = await read(); return now.place === "overview" && now.boxes.length > 0; }, "the overview from the picker");
        assert.deepEqual((await read()).pressed, [JOB], "the selection is kept");
      } finally {
        browser.close();
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });

    it("a short webview never scrolls the page: the Issues list fits, and its items scroll inside it", async function () {
      assert.ok(process.env.E2E_CDP_PORT, "run with npm run test:e2e:graph-refresh");
      const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      // The previous test closes every editor. Until that close has finished, it can also
      // close the graph this test opens while it loads, and the graph then quietly stays
      // closed, so wait for the old graph tab to be gone.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitFor(
        async () => !vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview)),
        "the previous graph to close",
      );
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, "alpha/databricks.yml")));
      await vscode.commands.executeCommand("databricksBundleInspector.openBundleIssues");

      const browser = await connectBrowser(process.env.E2E_CDP_PORT);
      try {
        let graph: { sessionId: string; contextId: number } | undefined;
        const evaluate = async (expression: string) => {
          const result = await browser.call("Runtime.evaluate", { expression, contextId: graph!.contextId, returnByValue: true }, graph!.sessionId);
          assert.ok(!result.exceptionDetails, "graph script must execute");
          return result.result?.value;
        };
        // Opened from the bundle file, so the panel is on the bundle overview with every issue listed.
        const panel = `document.querySelector('[aria-label="Close Bundle Issues"]')?.closest('div.absolute')`;
        await waitFor(async () => {
          const { targetInfos } = await browser.call("Target.getTargets");
          for (const target of targetInfos.filter((item: any) => item.type === "iframe" && item.url.startsWith("vscode-webview://"))) {
            const { sessionId } = await browser.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
            const { frameTree } = await browser.call("Page.getFrameTree", {}, sessionId);
            const frames: any[] = [];
            const visit = (node: any) => { frames.push(node.frame); for (const child of node.childFrames ?? []) visit(child); };
            visit(frameTree);
            for (const frame of frames) {
              const { executionContextId } = await browser.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dbi-layout-test" }, sessionId);
              graph = { sessionId, contextId: executionContextId };
              if (await evaluate(`Boolean(${panel})`)) return true;
            }
            await browser.call("Target.detachFromTarget", { sessionId });
          }
          return false;
        }, "the open Issues list");

        // As with the Problems panel open below a small editor. The webview gets less than
        // the size asked for (about 100px goes to VS Code's frame around it).
        await browser.call("Emulation.setVisibleSize", { width: 1000, height: 230 }, graph!.sessionId);
        await sleep(500);
        const short = await evaluate(`(() => { const p = ${panel}; const list = p.querySelector('.overflow-auto');
          return { height: innerHeight, needed: p.getBoundingClientRect().top + p.firstElementChild.getBoundingClientRect().height + list.scrollHeight }; })()`);
        // Otherwise the Issues list fits anyway and the test proves nothing.
        assert.ok(short.needed > short.height + 20, `the Issues list should need more room than the webview has: ${JSON.stringify(short)}`);
        const box = await evaluate(`(() => { const r = ${panel}.querySelector('.overflow-auto').getBoundingClientRect(); return { x: r.left + r.width / 2, y: Math.min(r.top + 10, innerHeight - 5) }; })()`);
        for (let i = 0; i < 20; i++) {
          await browser.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 400 }, graph!.sessionId);
        }
        await sleep(300);
        const layout = await evaluate(`({
          pageTaller: document.documentElement.scrollHeight > innerHeight,
          scrollY,
          headerTop: Math.round(document.querySelector('header').getBoundingClientRect().top),
          panelInside: ${panel}.getBoundingClientRect().bottom <= innerHeight,
          listScrolls: (() => { const list = ${panel}.querySelector('.overflow-auto'); return list.scrollHeight > list.clientHeight && getComputedStyle(list).overflowY === 'auto'; })(),
        })`);
        assert.deepEqual(layout, { pageTaller: false, scrollY: 0, headerTop: 0, panelInside: true, listScrolls: true });
      } finally {
        browser.close();
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });
  });
}

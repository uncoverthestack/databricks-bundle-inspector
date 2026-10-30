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

/** VS Code's built-in themes, by the name `workbench.colorTheme` takes. */
const THEMES = [
  { name: "Default Dark Modern", kind: "vscode-dark", mode: "dark" },
  { name: "Default Light Modern", kind: "vscode-light", mode: "light" },
  { name: "Default Dark+", kind: "vscode-dark", mode: "dark" },
  { name: "Default Light+", kind: "vscode-light", mode: "light" },
  { name: "Default High Contrast", kind: "vscode-high-contrast", mode: "dark" },
  { name: "Default High Contrast Light", kind: "vscode-high-contrast-light", mode: "light" },
] as const;

/**
 * Runs in the graph's page. Measures what is on screen: every piece of visible text with
 * its contrast against the background it actually sits on (alpha and opacity included),
 * the task boxes' borders against the canvas, and the edge labels.
 */
const MEASURE = String.raw`(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // The browser parses any CSS colour (oklab, color(), color-mix results) for us.
  const rgba = (value) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillStyle = value || "rgba(0,0,0,0)";
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (key) => (top[key] * top.a + bottom[key] * bottom.a * (1 - top.a)) / a;
    return { r: mix("r"), g: mix("g"), b: mix("b"), a };
  };
  const backgroundOf = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color.a > 0) layers.push(color);
      if (color.a >= 1) break;
    }
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  };
  const opacityOf = (el) => {
    let value = 1;
    for (let node = el; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
    return value;
  };
  const luminance = ({ r, g, b }) => {
    const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const hex = ({ r, g, b }) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
  };

  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg") || !visible(el)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    if (!own) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden") continue;
    const bg = backgroundOf(el);
    const fg = rgba(style.color);
    const shown = over({ ...fg, a: fg.a * opacityOf(el) }, bg);
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight);
    texts.push({
      text: own.slice(0, 40),
      ratio: ratio(shown, bg),
      fg: hex(shown),
      bg: hex(bg),
      large: size >= 24 || (size >= 18.66 && weight >= 700),
      badge: Boolean(el.closest(".react-flow__node .font-mono")),
      dimmed: opacityOf(el) < 1,
    });
  }

  const pane = document.querySelector(".react-flow");
  const canvasBg = pane ? backgroundOf(pane) : { r: 0, g: 0, b: 0, a: 1 };
  const boxes = [...document.querySelectorAll(".react-flow__node > div")].map((box) => ({
    name: box.textContent.trim().slice(0, 30),
    border: ratio(over(rgba(getComputedStyle(box).borderTopColor), canvasBg), canvasBg),
    dimmed: opacityOf(box) < 1,
  }));
  const edgeLabels = [...document.querySelectorAll(".react-flow__edge-text")].map((text) => {
    const rect = text.parentElement.querySelector(".react-flow__edge-textbg");
    const bg = over(rgba(rect ? getComputedStyle(rect).fill : "transparent"), canvasBg);
    return { text: text.textContent, ratio: ratio(over(rgba(getComputedStyle(text).fill), bg), bg) };
  });

  return {
    kind: document.body.dataset.vscodeThemeKind,
    flowMode: pane?.classList.contains("light") ? "light" : pane?.classList.contains("dark") ? "dark" : "none",
    surface: hex(rgba(getComputedStyle(document.body).backgroundColor)),
    header: hex(rgba(getComputedStyle(document.querySelector("header")).backgroundColor)),
    canvas: hex(rgba(getComputedStyle(pane).backgroundColor)),
    panelVar: getComputedStyle(document.documentElement).getPropertyValue("--vscode-sideBar-background"),
    editorBackground: hex(rgba(getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-background"))),
    texts,
    boxes,
    edgeLabels,
  };
})()`;

/** Whether a `#rrggbb` colour is on the light side, by its average channel. */
const isLight = (hex: string) => [1, 3, 5].reduce((sum, at) => sum + parseInt(hex.slice(at, at + 2), 16), 0) / 3 > 127;

/** The bar each piece of text has to clear: WCAG AA, 4.5:1, or 3:1 for large text. */
const failsAa = (text: { ratio: number; large: boolean }) => text.ratio < (text.large ? 3 : 4.5);

export function themesSuite() {
  describe("graph colours follow the VS Code theme", function () {
    this.timeout(300_000);
    let browser: Browser;
    let sessionId = "";
    let contextId = 0;
    const report: Record<string, unknown> = {};
    const shots = path.resolve(__dirname, "../themes");

    const evaluate = async (expression: string) => {
      const result = await browser.call("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId);
      assert.ok(!result.exceptionDetails, `graph script must run: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result?.value;
    };
    const setTheme = async (name: string) =>
      vscode.workspace.getConfiguration("workbench").update("colorTheme", name, vscode.ConfigurationTarget.Global);

    /** Opens the graph and attaches to the frame that renders it. */
    const openGraph = async () => {
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
            const world = await browser.call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dbi-theme-test" }, attached.sessionId);
            sessionId = attached.sessionId;
            contextId = world.executionContextId;
            if (await evaluate(`document.querySelectorAll(".react-flow__node").length`) >= 5) return true;
          }
          await browser.call("Target.detachFromTarget", { sessionId: attached.sessionId });
        }
        return false;
      }, "the rendered graph");
    };

    const screenshot = async (name: string) => {
      const { targetInfos } = await browser.call("Target.getTargets");
      const page = targetInfos.find((item: any) => item.type === "page" && item.url.includes("workbench"));
      if (!page) return;
      const { sessionId: pageSession } = await browser.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const { data } = await browser.call("Page.captureScreenshot", { format: "png" }, pageSession);
      mkdirSync(shots, { recursive: true });
      writeFileSync(path.join(shots, `${name.replace(/[^\w]+/g, "-")}.png`), Buffer.from(data, "base64"));
      await browser.call("Target.detachFromTarget", { sessionId: pageSession });
    };

    /**
     * The colours actually on screen at a blank spot of the header and of the canvas, read
     * from a screenshot of the window. Computed styles alone missed a stale paint once.
     */
    const painted = async () => {
      const { targetInfos } = await browser.call("Target.getTargets");
      const page = targetInfos.find((item: any) => item.type === "page" && item.url.includes("workbench"));
      const { sessionId: pageSession } = await browser.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      try {
        const frame = await browser.call("Runtime.evaluate", {
          expression: `(() => { const box = [...document.querySelectorAll("iframe.webview")].map(f => f.getBoundingClientRect()).find(r => r.width > 0); return { x: box.x, y: box.y }; })()`,
          returnByValue: true,
        }, pageSession);
        const offset = frame.result.value as { x: number; y: number };
        // The canvas spot must be bare canvas: away from the boxes, edges, zoom buttons and
        // minimap (whose shadows tint what is near them), and midway between the dots,
        // which sit at 1px in each 16px tile.
        const spots = await evaluate(`(() => {
          const header = document.querySelector("header").getBoundingClientRect();
          const pane = document.querySelector(".react-flow").getBoundingClientRect();
          const avoid = [...document.querySelectorAll(".react-flow__node, .react-flow__controls, .react-flow__minimap, .react-flow__edge")]
            .map(el => el.getBoundingClientRect());
          const clear = (x, y) => avoid.every(r => x < r.left - 48 || x > r.right + 48 || y < r.top - 48 || y > r.bottom + 48);
          for (let y = pane.top + 9; y < pane.bottom; y += 16) {
            for (let x = pane.left + 9; x < pane.right; x += 16) {
              const top = document.elementFromPoint(x, y);
              if (clear(x, y) && top && top.closest(".react-flow__pane, .react-flow__background")) {
                return { header: { x: header.right - 3, y: header.top + 3 }, canvas: { x, y } };
              }
            }
          }
          return null;
        })()`) as Record<string, { x: number; y: number }> | null;
        assert.ok(spots, "a bare spot of canvas to read");
        const result: Record<string, string> = {};
        for (const [name, spot] of Object.entries(spots)) {
          const clip = { x: offset.x + spot.x, y: offset.y + spot.y, width: 1, height: 1, scale: 1 };
          const { data } = await browser.call("Page.captureScreenshot", { format: "png", clip }, pageSession);
          // The graph page decodes the PNG; its CSP allows data: images.
          result[name] = await evaluate(`(async () => {
            const image = new Image();
            image.src = "data:image/png;base64,${data}";
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
          })()`);
        }
        return result;
      } finally {
        await browser.call("Target.detachFromTarget", { sessionId: pageSession });
      }
    };

    /**
     * Measures once the new theme has fully landed (#313). The theme kind changes before
     * every colour variable does, so a fixed wait once measured Light Modern's text against
     * Dark Modern's background. Waits until React Flow's mode, the page surface and the
     * editor background all agree with the theme, and two reads in a row are the same.
     * On a timeout it returns the last read, so the assertions say what was wrong.
     */
    const measureSettled = async (mode: string) => {
      const deadline = Date.now() + 20_000;
      let last = "";
      let measured: any;
      while (Date.now() < deadline) {
        measured = await evaluate(MEASURE);
        const read = JSON.stringify(measured);
        const landed =
          measured.flowMode === mode &&
          measured.surface === measured.editorBackground &&
          isLight(measured.editorBackground) === (mode === "light");
        if (landed && read === last) return measured;
        last = read;
        await sleep(100);
      }
      return measured;
    };

    const clickTask = (name: string) =>
      evaluate(`[...document.querySelectorAll(".react-flow__node")].find(node => node.textContent.includes(${JSON.stringify(name)}))?.click()`);

    before(async function () {
      assert.ok(process.env.E2E_CDP_PORT, "run with npm run test:e2e:themes");
      browser = await connectBrowser(process.env.E2E_CDP_PORT);
      await setTheme(THEMES[0].name);
      await openGraph();
    });

    after(async () => {
      writeFileSync(path.resolve(__dirname, "../themes-report.json"), JSON.stringify(report, null, 2));
      browser?.close();
      await setTheme(THEMES[0].name);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    for (const theme of THEMES) {
      it(`${theme.name}: switched with the graph open`, async () => {
        await setTheme(theme.name);
        await waitFor(async () => (await evaluate(`document.body.dataset.vscodeThemeKind`)) === theme.kind, `theme kind ${theme.kind}`);
        const plain = await measureSettled(theme.mode);
        const onScreen = await painted();
        await screenshot(theme.name);
        await clickTask("missing_step");
        await sleep(300);
        const selected = await evaluate(MEASURE);
        await screenshot(`${theme.name} selected`);
        await clickTask("missing_step");
        await sleep(200);
        report[theme.name] = { plain, selected, onScreen };

        assert.equal(plain.flowMode, theme.mode, "React Flow's colour mode");
        assert.equal(plain.surface, plain.editorBackground, "the page uses the editor background");
        assert.deepEqual(onScreen, { header: plain.header, canvas: plain.canvas }, "painted colours match the theme");
        const texts = [...plain.texts, ...selected.texts];
        const failing = texts.filter((text: any) => !text.dimmed && failsAa(text));
        assert.deepEqual(failing, [], "text below WCAG AA");
        const labels = plain.edgeLabels.filter(failsAa);
        assert.deepEqual(labels, [], "edge labels below WCAG AA");
        // WCAG 1.4.11: a component's outline needs 3:1 against what is next to it.
        const faint = [...plain.boxes, ...selected.boxes].filter((box: any) => !box.dimmed && box.border < 3);
        assert.deepEqual(faint, [], "task box borders against the canvas");
      });
    }

    it("a theme colour VS Code leaves out falls back to the default, never to nothing", async () => {
      await setTheme("Default Dark Modern");
      await waitFor(async () => (await evaluate(`document.body.dataset.vscodeThemeKind`)) === "vscode-dark", "dark theme");
      const read = `(() => {
        const controls = document.querySelector(".react-flow__controls");
        const header = document.querySelector("header");
        return { controls: getComputedStyle(controls).borderTopColor, header: getComputedStyle(header).backgroundColor };
      })()`;
      const before = await evaluate(read);
      const removed = await evaluate(`(() => {
        const style = document.documentElement.style;
        const saved = { border: style.getPropertyValue("--vscode-panel-border"), side: style.getPropertyValue("--vscode-sideBar-background") };
        style.removeProperty("--vscode-panel-border");
        style.removeProperty("--vscode-sideBar-background");
        const result = {
          controls: getComputedStyle(document.querySelector(".react-flow__controls")).borderTopColor,
          header: getComputedStyle(document.querySelector("header")).backgroundColor,
        };
        style.setProperty("--vscode-panel-border", saved.border);
        style.setProperty("--vscode-sideBar-background", saved.side);
        return result;
      })()`);
      report.fallback = { before, removed };
      assert.notEqual(before.controls, removed.controls, "the theme's border colour was in use");
      assert.equal(removed.controls, "rgb(41, 37, 36)", "panel border falls back to #292524");
      assert.equal(removed.header, "rgb(13, 13, 13)", "side bar background falls back to #0d0d0d");
    });

    it("without VS Code's colours and theme kind (the standalone preview), the view is dark as before", async () => {
      const result = await evaluate(`(async () => {
        const root = document.documentElement;
        const saved = root.getAttribute("style");
        const kind = document.body.dataset.vscodeThemeKind;
        for (const name of [...root.style].filter(name => name.startsWith("--vscode-"))) root.style.removeProperty(name);
        delete document.body.dataset.vscodeThemeKind;
        await new Promise(resolve => setTimeout(resolve, 300));
        const pane = document.querySelector(".react-flow");
        const result = {
          flowMode: pane.classList.contains("light") ? "light" : "dark",
          body: getComputedStyle(document.body).backgroundColor,
          text: getComputedStyle(document.querySelector(".react-flow__node .truncate")).color,
        };
        root.setAttribute("style", saved);
        document.body.dataset.vscodeThemeKind = kind;
        await new Promise(resolve => setTimeout(resolve, 300));
        return result;
      })()`);
      report.standalone = result;
      assert.equal(result.flowMode, "dark");
      assert.equal(result.body, "rgb(17, 17, 17)", "page background falls back to #111111");
      assert.equal(result.text, "rgb(231, 229, 228)", "text falls back to #e7e5e4");
    });

    it("a graph opened while a light theme is active starts light", async () => {
      await setTheme("Default Light Modern");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await sleep(500);
      await openGraph();
      const first = await evaluate(MEASURE);
      report.reopenedLight = { flowMode: first.flowMode, kind: first.kind };
      assert.equal(first.kind, "vscode-light");
      assert.equal(first.flowMode, "light");
    });
  });
}

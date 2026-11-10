/** Minimal CDP client, used only inside the real VS Code test window. */
export class Browser {
  private next = 0;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  constructor(private socket: WebSocket) {
    socket.addEventListener("message", event => {
      const data = JSON.parse(String(event.data));
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (data.error) pending.reject(new Error(JSON.stringify(data.error)));
      else pending.resolve(data.result);
    });
  }
  call(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timed out: ${method}`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser connection closed"));
    }
    this.pending.clear();
    this.socket.close();
  }
}

/** Connects to the test VS Code's Chromium, on the port `runTest.ts` opened for the suite. */
export async function connectBrowser(port: string): Promise<Browser> {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Cannot connect to VS Code's browser")), { once: true });
  });
  return new Browser(socket);
}

export interface PanelSize {
  width: number;
  height: number;
}

/**
 * The panel size layout tests run at: wide enough for the bundle overview's two columns
 * and its lines (768px and up), narrow enough that a box's details sit below (under 1024px).
 */
export const STANDARD_PANEL: PanelSize = { width: 1000, height: 700 };

export interface PanelSizer {
  /** Makes the panel's content exactly this size, whatever size the window started at. */
  set(size: PanelSize): Promise<void>;
  /** Gives the window its own size back. */
  release(): Promise<void>;
}

/**
 * Owns the size of the graph panel for a suite or a test. A test that reads layout must
 * not depend on the window VS Code happens to open: the CI machines' windows are small
 * enough to stack the overview's columns, and that broke the merge queue three times.
 *
 * It resizes the whole VS Code window through Chromium's device emulation, by what the
 * window keeps beside the panel, then measures and corrects until the panel is right.
 * The window-level override is the one way that works on every CI system; a frame cannot
 * be sized directly. One sizer per browser connection: a second one would undo the first.
 *
 * @param panelSize Reads the panel's current size, from inside the panel's page.
 */
export async function panelSizer(browser: Browser, panelSize: () => Promise<PanelSize>): Promise<PanelSizer> {
  const { targetInfos } = await browser.call("Target.getTargets");
  const workbench = targetInfos.find((item: any) => item.type === "page" && item.url.includes("workbench"));
  if (!workbench) throw new Error("No VS Code window to size");
  const { sessionId } = await browser.call("Target.attachToTarget", { targetId: workbench.targetId, flatten: true });
  const windowSize = async (): Promise<PanelSize> =>
    (await browser.call("Runtime.evaluate", { expression: "({ width: innerWidth, height: innerHeight })", returnByValue: true }, sessionId)).result.value;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const near = (a: PanelSize, b: PanelSize) => Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

  return {
    async set(size) {
      let panel = await panelSize();
      // A hidden frame has the browser's default size. Sizing by it would be nonsense.
      if (panel.width === 300 && panel.height === 150) {
        throw new Error("The panel is hidden (300x150). Bring it to the front before sizing it.");
      }
      const window = await windowSize();
      let ask = { width: size.width + window.width - panel.width, height: size.height + window.height - panel.height };
      for (let attempt = 0; attempt < 8; attempt++) {
        await browser.call("Emulation.setDeviceMetricsOverride", { ...ask, deviceScaleFactor: 1, mobile: false }, sessionId);
        // The panel follows the window a moment later. Wait for it to settle before judging.
        let last: PanelSize | undefined;
        for (let waited = 0; waited < 3000; waited += 100) {
          await sleep(100);
          panel = await panelSize();
          if (near(panel, size)) return;
          if (last && near(last, panel) && waited >= 400) break;
          last = panel;
        }
        // Other parts of the window took some of the change: correct by what is missing.
        ask = { width: ask.width + size.width - panel.width, height: ask.height + size.height - panel.height };
      }
      throw new Error(`Could not size the panel to ${size.width}x${size.height}: it is ${panel.width}x${panel.height}`);
    },
    async release() {
      await browser.call("Emulation.clearDeviceMetricsOverride", {}, sessionId);
      await browser.call("Target.detachFromTarget", { sessionId });
    },
  };
}

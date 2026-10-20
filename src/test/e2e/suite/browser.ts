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

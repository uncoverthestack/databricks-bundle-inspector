/** Injected by VS Code into webview scripts (https://code.visualstudio.com/api/extension-guides/webview). */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

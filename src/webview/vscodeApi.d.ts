/** Injected by VS Code into webview scripts (https://code.visualstudio.com/api/extension-guides/webview). */
declare function acquireVsCodeApi(): {
  /** Checked against the messages the extension handles (shared/webviewMessages.ts). */
  postMessage(message: import("../shared/webviewMessages").WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

import { useEffect, useState } from "react";
import App from "./App";

// acquireVsCodeApi is injected by VS Code into webview scripts at runtime.
// It is declared as a global in eslint.config.js so the linter doesn't flag it.
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

export default function Bootstrap() {
  const [parsedBundle, setParsedBundle] = useState(null);

  useEffect(() => {
    vscodeApi?.postMessage({ type: "webviewReady" });

    function handleMessage(event) {
      const { data } = event;
      if (typeof data !== "object" || data === null) {
        return;
      }
      if (
        data.type === "bundleData" &&
        typeof data.parsedBundle === "object" &&
        data.parsedBundle !== null
      ) {
        setParsedBundle(data.parsedBundle);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  if (!parsedBundle) {
    return (
      <div className="flex h-screen items-center justify-center bg-stone-950 text-sm text-stone-300">
        No bundle data was provided by the extension.
      </div>
    );
  }

  return <App parsedBundle={parsedBundle} />;
}

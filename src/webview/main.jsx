import React, { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Bootstrap() {
  const [parsedBundle, setParsedBundle] = useState(null);

  useEffect(() => {
    vscodeApi?.postMessage({ type: "webviewReady" });

    function handleMessage(event) {
      if (event.data?.type === "bundleData") {
        setParsedBundle(event.data.parsedBundle ?? null);
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

const container = document.getElementById("root");

if (container) {
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <Bootstrap />
    </StrictMode>,
  );
}

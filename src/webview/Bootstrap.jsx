import { useEffect, useState } from "react";
import App from "./App";

// acquireVsCodeApi is injected by VS Code into webview scripts at runtime.
// It is declared as a global in eslint.config.js so the linter doesn't flag it.
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

export default function Bootstrap() {
  const [parsedBundle, setParsedBundle] = useState(null);
  const [resolutionBundle, setResolutionBundle] = useState(null);
  const [bundleGraph, setBundleGraph] = useState(null);
  const [validationIssues, setValidationIssues] = useState([]);
  const [inspectorIssues, setInspectorIssues] = useState([]);
  const [inspectedTarget, setInspectedTarget] = useState(null);
  const [inspectedTargetMode, setInspectedTargetMode] = useState(null);
  const [requestedTarget, setRequestedTarget] = useState(null);
  const [targetOptions, setTargetOptions] = useState([]);
  const [targetFallbackMessage, setTargetFallbackMessage] = useState(null);
  const [focusIssuesNonce, setFocusIssuesNonce] = useState(null);

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
        setResolutionBundle(
          typeof data.resolutionBundle === "object" &&
            data.resolutionBundle !== null
            ? data.resolutionBundle
            : data.parsedBundle,
        );
        if (typeof data.graph === "object" && data.graph !== null) {
          setBundleGraph(data.graph);
        }
        setValidationIssues(
          Array.isArray(data.validationIssues) ? data.validationIssues : [],
        );
        setInspectorIssues(
          Array.isArray(data.inspectorIssues) ? data.inspectorIssues : [],
        );
        setInspectedTarget(
          typeof data.inspectedTarget === "string" ? data.inspectedTarget : null,
        );
        setInspectedTargetMode(
          typeof data.inspectedTargetMode === "string"
            ? data.inspectedTargetMode
            : null,
        );
        setRequestedTarget(
          typeof data.requestedTarget === "string" ? data.requestedTarget : null,
        );
        setTargetOptions(
          Array.isArray(data.targetOptions)
            ? data.targetOptions.filter((item) => typeof item === "string")
            : [],
        );
        setTargetFallbackMessage(
          typeof data.targetFallbackMessage === "string"
            ? data.targetFallbackMessage
            : null,
        );
        setFocusIssuesNonce(
          typeof data.focusIssuesNonce === "number"
            ? data.focusIssuesNonce
            : null,
        );
      }
      if (data.type === "focusIssues") {
        setFocusIssuesNonce(Date.now());
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

  function handleOpenFile(filePath, line, column) {
    vscodeApi?.postMessage({
      type: "openFile",
      path: filePath,
      line: line ?? undefined,
      column: column ?? undefined,
    });
  }

  function handleSelectTarget(target) {
    vscodeApi?.postMessage({
      type: "selectTarget",
      target: target || null,
    });
  }

  function handleCopyReviewSummary(markdown) {
    vscodeApi?.postMessage({
      type: "copyReviewSummary",
      markdown,
    });
  }

  return (
    <App
      key={focusIssuesNonce ?? "inspector"}
      parsedBundle={parsedBundle}
      resolutionBundle={resolutionBundle ?? parsedBundle}
      graph={bundleGraph}
      validationIssues={validationIssues}
      inspectorIssues={inspectorIssues}
      inspectedTarget={inspectedTarget}
      inspectedTargetMode={inspectedTargetMode}
      requestedTarget={requestedTarget}
      targetOptions={targetOptions}
      targetFallbackMessage={targetFallbackMessage}
      focusIssuesNonce={focusIssuesNonce}
      onSelectTarget={handleSelectTarget}
      onOpenFile={handleOpenFile}
      onCopyReviewSummary={handleCopyReviewSummary}
    />
  );
}

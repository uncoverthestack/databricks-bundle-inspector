import { useEffect, useState } from "react";
import App from "./App";
import { contextMenuContext } from "./lib/textSelection";

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
  const [targetFallbackReason, setTargetFallbackReason] = useState(null);
  const [profileChoice, setProfileChoice] = useState(null);
  const [focusIssuesNonce, setFocusIssuesNonce] = useState(null);
  const [initialJob, setInitialJob] = useState(null);

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
        setTargetFallbackReason(
          typeof data.targetFallbackReason === "string" ? data.targetFallbackReason : null,
        );
        setProfileChoice(
          data.profileChoice && Array.isArray(data.profileChoice.names)
            ? data.profileChoice
            : null,
        );
        // Data refreshes keep the view; explicit Inspect or Issues requests can reset it.
        if (typeof data.focusIssuesNonce === "number") {
          setFocusIssuesNonce(data.focusIssuesNonce);
        } else if (!data.preserveView) {
          setFocusIssuesNonce(null);
        }
        // Kept until the next one, so a target switch stays on the job the user is viewing.
        if (
          data.initialJob &&
          typeof data.initialJob.key === "string" &&
          typeof data.initialJob.nonce === "number"
        ) {
          setInitialJob(data.initialJob);
        }
      }
      if (data.type === "focusIssues") {
        setFocusIssuesNonce(Date.now());
      }
    }

    // Runs before VS Code's own listener on the window, which reads the context
    // set here to build the menu. The text is sent now, while it is still selected.
    function handleContextMenu(event) {
      const inTextBox =
        event.target instanceof Element &&
        Boolean(event.target.closest("input, textarea, [contenteditable='true']"));
      const text = window.getSelection()?.toString() ?? "";
      document.body.dataset.vscodeContext = JSON.stringify(
        contextMenuContext(inTextBox, text),
      );
      if (!inTextBox) vscodeApi?.postMessage({ type: "contextMenuSelection", text });
    }

    window.addEventListener("message", handleMessage);
    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      window.removeEventListener("message", handleMessage);
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  if (!parsedBundle) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-sm text-fg-soft">
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

  function handleChooseProfile() {
    vscodeApi?.postMessage({ type: "chooseProfile" });
  }

  function handleSelectTarget(target) {
    vscodeApi?.postMessage({
      type: "selectTarget",
      target: target || null,
    });
  }

  // Only allow-listed event names and properties are forwarded by the extension.
  function handleTelemetry(event, properties) {
    vscodeApi?.postMessage({ type: "telemetry", event, properties });
  }

  function handleCopyReviewSummary(markdown) {
    vscodeApi?.postMessage({
      type: "copyReviewSummary",
      markdown,
    });
  }

  return (
    <App
      key={`${focusIssuesNonce ?? "inspector"}:${initialJob?.nonce ?? ""}`}
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
      targetFallbackReason={targetFallbackReason}
      profileChoice={profileChoice}
      onChooseProfile={handleChooseProfile}
      focusIssuesNonce={focusIssuesNonce}
      initialJobKey={initialJob?.key}
      onSelectTarget={handleSelectTarget}
      onOpenFile={handleOpenFile}
      onCopyReviewSummary={handleCopyReviewSummary}
      onTelemetry={handleTelemetry}
    />
  );
}

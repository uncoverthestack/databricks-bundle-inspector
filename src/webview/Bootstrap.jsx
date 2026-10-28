import { useEffect, useState } from "react";
import App from "./App";
import { contextMenuContext } from "./lib/textSelection";
import { PROFILE_SOURCES } from "./lib/signsInAs";

// acquireVsCodeApi is injected by VS Code into webview scripts at runtime.
// It is declared as a global in eslint.config.js so the linter doesn't flag it.
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

const SIGN_IN_STAGES = ["needed", "terminal", "updated", "checking"];

/** The sign-in banner's state from the extension, or null. */
function validSignIn(value) {
  return value && typeof value.target === "string" && SIGN_IN_STAGES.includes(value.stage)
    ? {
        target: value.target,
        stage: value.stage,
        blockedReason: typeof value.blockedReason === "string" ? value.blockedReason : null,
        signsInAs:
          typeof value.signsInAs?.profile === "string" && PROFILE_SOURCES.includes(value.signsInAs.source)
            ? { profile: value.signsInAs.profile, source: value.signsInAs.source }
            : null,
      }
    : null;
}

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
  const [signIn, setSignIn] = useState(null);
  const [focusIssuesNonce, setFocusIssuesNonce] = useState(null);
  const [initialResource, setInitialResource] = useState(null);

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
        setSignIn(validSignIn(data.signIn));
        // Data refreshes keep the view; explicit Inspect or Issues requests can reset it.
        if (typeof data.focusIssuesNonce === "number") {
          setFocusIssuesNonce(data.focusIssuesNonce);
        } else if (!data.preserveView) {
          setFocusIssuesNonce(null);
        }
        // Kept until the next one, so a target switch stays on what the user is viewing.
        if (
          data.initialResource &&
          (data.initialResource.group === "jobs" || data.initialResource.group === "pipelines") &&
          typeof data.initialResource.key === "string" &&
          typeof data.initialResource.nonce === "number"
        ) {
          setInitialResource(data.initialResource);
        }
      }
      // The sign-in banner moves on without new bundle data: terminal opened, profile saved, checking.
      if (data.type === "signIn") {
        setSignIn(validSignIn(data.signIn));
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

  function handleOpenSignInTerminal(target) {
    vscodeApi?.postMessage({ type: "openSignInTerminal", target });
  }

  function handleCheckTargetAgain(target) {
    vscodeApi?.postMessage({ type: "checkTargetAgain", target });
  }

  function handleOpenSignInGuide() {
    vscodeApi?.postMessage({ type: "openSignInGuide" });
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

  // The extension builds the full report: it knows the CLI's version and its own.
  function handleCopyReviewReport(jobKey) {
    vscodeApi?.postMessage({ type: "copyReviewReport", jobKey });
  }

  function handleCopyReviewSummary(markdown) {
    vscodeApi?.postMessage({
      type: "copyReviewSummary",
      markdown,
    });
  }

  return (
    <App
      key={`${focusIssuesNonce ?? "inspector"}:${initialResource?.nonce ?? ""}`}
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
      signIn={signIn}
      onOpenSignInTerminal={handleOpenSignInTerminal}
      onCheckTargetAgain={handleCheckTargetAgain}
      onOpenSignInGuide={handleOpenSignInGuide}
      focusIssuesNonce={focusIssuesNonce}
      initialResource={initialResource ? { group: initialResource.group, key: initialResource.key } : undefined}
      onSelectTarget={handleSelectTarget}
      onOpenFile={handleOpenFile}
      onCopyReviewSummary={handleCopyReviewSummary}
      onCopyReviewReport={handleCopyReviewReport}
      onTelemetry={handleTelemetry}
    />
  );
}

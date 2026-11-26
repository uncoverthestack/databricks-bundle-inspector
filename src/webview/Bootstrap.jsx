// @ts-check
import { useEffect, useState } from "react";
import App from "./App";
import { contextMenuContext } from "./lib/textSelection";
import { PROFILE_SOURCES } from "./lib/signsInAs";

// acquireVsCodeApi is injected by VS Code into webview scripts at runtime.
// It is declared as a global in eslint.config.js so the linter doesn't flag it.
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

const SIGN_IN_STAGES = ["needed", "terminal", "updated", "checking"];

/**
 * The sign-in banner's state from the extension, or null.
 * @param {any} value the message field, checked here
 */
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

/** @typedef {import("../bundle/graph/bundleGraph").ParsedBundleConfig} ParsedBundleConfig */

// Messages from the extension are untyped here: each field is checked before it is used.
export default function Bootstrap() {
  const [parsedBundle, setParsedBundle] = useState(/** @type {ParsedBundleConfig | null} */ (null));
  const [bundleRoot, setBundleRoot] = useState(/** @type {string | undefined} */ (undefined));
  const [resolutionBundle, setResolutionBundle] = useState(/** @type {ParsedBundleConfig | null} */ (null));
  const [bundleGraph, setBundleGraph] = useState(/** @type {import("../bundle/graph/bundleGraph").BundleGraph | null} */ (null));
  const [validationIssues, setValidationIssues] = useState(/** @type {import("../bundle/validateBundle").ValidationIssue[]} */ ([]));
  const [inspectorIssues, setInspectorIssues] = useState(/** @type {import("../bundle/issues").InspectorIssue[]} */ ([]));
  const [inspectedTarget, setInspectedTarget] = useState(/** @type {string | null} */ (null));
  const [inspectedTargetMode, setInspectedTargetMode] = useState(/** @type {string | null} */ (null));
  const [requestedTarget, setRequestedTarget] = useState(/** @type {string | null} */ (null));
  const [targetOptions, setTargetOptions] = useState(/** @type {string[]} */ ([]));
  const [targetFallbackMessage, setTargetFallbackMessage] = useState(/** @type {string | null} */ (null));
  const [targetFallbackReason, setTargetFallbackReason] = useState(/** @type {string | null} */ (null));
  const [profileChoice, setProfileChoice] = useState(/** @type {{ host: string, names: string[] } | null} */ (null));
  const [signIn, setSignIn] = useState(/** @type {ReturnType<typeof validSignIn>} */ (null));
  const [focusIssuesNonce, setFocusIssuesNonce] = useState(/** @type {number | null} */ (null));
  const [initialResource, setInitialResource] = useState(/** @type {(import("../bundle/resourceFiles").GraphResource & { nonce: number }) | null} */ (null));

  useEffect(() => {
    vscodeApi?.postMessage({ type: "webviewReady" });

    /** @param {MessageEvent} event */
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
        setBundleRoot(data.bundleRoot);
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
            ? data.targetOptions.filter((/** @type {unknown} */ item) => typeof item === "string")
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
    /** @param {MouseEvent} event */
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

  /**
   * @param {string} filePath
   * @param {number | null} [line]
   * @param {number | null} [column]
   * @param {string} [resourceType]
   */
  function handleOpenFile(filePath, line, column, resourceType) {
    vscodeApi?.postMessage({
      type: "openFile",
      path: filePath,
      line: line ?? undefined,
      column: column ?? undefined,
      resourceType,
    });
  }

  function handleChooseProfile() {
    vscodeApi?.postMessage({ type: "chooseProfile" });
  }

  /** @param {string} target */
  function handleOpenSignInTerminal(target) {
    vscodeApi?.postMessage({ type: "openSignInTerminal", target });
  }

  /** @param {string} target */
  function handleCheckTargetAgain(target) {
    vscodeApi?.postMessage({ type: "checkTargetAgain", target });
  }

  function handleOpenSignInGuide() {
    vscodeApi?.postMessage({ type: "openSignInGuide" });
  }

  /** @param {string | null | undefined} target */
  function handleSelectTarget(target) {
    vscodeApi?.postMessage({
      type: "selectTarget",
      target: target || null,
    });
  }

  // Only allow-listed event names and properties are forwarded by the extension.
  /**
   * @param {string} event
   * @param {Record<string, unknown>} [properties]
   */
  function handleTelemetry(event, properties) {
    vscodeApi?.postMessage({ type: "telemetry", event, properties });
  }

  // The extension builds the full report: it knows the CLI's version and its own.
  /** @param {string} jobKey */
  function handleCopyReviewReport(jobKey) {
    vscodeApi?.postMessage({ type: "copyReviewReport", jobKey });
  }

  /** @param {string} markdown */
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
      bundleRoot={bundleRoot}
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

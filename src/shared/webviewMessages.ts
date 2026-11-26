/**
 * The messages between the extension and the webview (#699). Both import these types, so a
 * field renamed on one side fails the build on the other. They describe what the code sends;
 * each side still checks what arrives, since a message is data from another process.
 *
 * Both ship in the same VSIX, so the two sides always share one version of this file: fields
 * can be added, renamed or removed without versioning.
 */
import type { BundleGraph, ParsedBundleConfig } from "../bundle/graph/bundleGraph.js";
import type { InspectorIssue } from "../bundle/issues.js";
import type { OutsideReportVariable } from "../bundle/reportVariableSources.js";
import type { GraphResource } from "../bundle/resourceFiles.js";
import type { ValidationIssue } from "../bundle/validateBundle.js";
import type { ProfileSource } from "../databricksCli/signIn.js";

/**
 * Where a sign-in for a target stands, as the graph's banner shows it. One state at a time:
 * `needed` (the target fell back for want of a sign-in), `terminal` (the command is typed,
 * waiting for Enter), `updated` (the CLI saved the profile; nothing checks by itself),
 * `checking` (the user asked to check the target again).
 */
export type SignInStage = "needed" | "terminal" | "updated" | "checking";

/** The graph's sign-in banner (see extension/signInFlow.ts). */
export interface SignInBanner {
  target: string;
  stage: SignInStage;
  /** Why the terminal isn't offered, when signing in here would be unsafe or can't work. */
  blockedReason?: string;
  /** Before the click: the name the sign-in will use, and where it comes from. */
  signsInAs?: { profile: string; source: ProfileSource };
}

/**
 * What the panel shows after an inspection. The extension also keeps the last one it sent:
 * a panel that opens later gets it, and the review report is built from it.
 */
export interface BundleData {
  parsedBundle: ParsedBundleConfig;
  bundleRoot: string;
  /** The structural preview's bundle, for the review report only. */
  writtenBundle: ParsedBundleConfig | undefined;
  /** The CLI's version output, for the review report only. */
  cliVersion: string | undefined;
  /** Variables set outside the bundle files, for the review report only. */
  outsideVariables: OutsideReportVariable[] | undefined;
  resolutionBundle: ParsedBundleConfig;
  graph: BundleGraph;
  validationIssues: ValidationIssue[];
  inspectorIssues: InspectorIssue[];
  targetOptions: string[];
  inspectedTarget: string | undefined;
  inspectedTargetMode: "probe" | "target" | undefined;
  requestedTarget: string | null;
  targetFallbackMessage: string | null;
  targetFallbackReason: string | null;
  signIn: SignInBanner | null;
  /** Several profiles match the target's workspace: the graph offers a choice. */
  profileChoice: { host: string; names: string[] } | null;
  /** Set when the panel should open on Issues; a new value each time. */
  focusIssuesNonce: number | null;
  /** A refresh that keeps the panel's view. */
  preserveView: boolean;
  /** The job or pipeline to open on; the nonce makes asking again for the same one count. */
  initialResource: (GraphResource & { nonce: number }) | null;
}

/** Extension to webview. */
export type ExtensionMessage =
  | ({ type: "bundleData" } & BundleData)
  | { type: "signIn"; signIn: SignInBanner | null }
  | { type: "focusIssues" };

/** Webview to extension. */
export type WebviewMessage =
  | { type: "webviewReady" }
  | { type: "selectTarget"; target: string | null }
  | { type: "chooseProfile" }
  | { type: "openSignInTerminal"; target: string }
  | { type: "checkTargetAgain"; target: string }
  | { type: "openSignInGuide" }
  | { type: "openFile"; path: string; line: number | undefined; column: number | undefined; resourceType: string | undefined }
  | { type: "copyReviewReport"; jobKey?: string | undefined }
  | { type: "copyReviewSummary"; markdown: string }
  | { type: "contextMenuSelection"; text: string }
  | { type: "telemetry"; event: string; properties?: Record<string, unknown> | undefined };

/**
 * A message from the webview of the given type, with its fields still unchecked: the caller
 * checks each before use. Only the type is checked here, so a misspelt type fails the build.
 */
export function isWebviewMessage<T extends WebviewMessage["type"]>(
  message: unknown,
  type: T,
): message is { type: T } & Partial<Record<Exclude<keyof Extract<WebviewMessage, { type: T }>, "type">, unknown>> {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === type;
}

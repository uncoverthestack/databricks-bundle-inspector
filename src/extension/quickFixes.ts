import * as vscode from "vscode";
import type { InspectorIssueKind, IssueFix } from "../bundle/issues.js";
import { locateFix } from "../bundle/quickFix.js";

/** A fix the last check offered, keyed to the diagnostic it belongs to. */
export interface StoredFix extends IssueFix {
  kind: InspectorIssueKind;
  /** 0-based, as the diagnostic's range. */
  line: number;
  /** 1-based, as the issue reported it. */
  column?: number | undefined;
  message: string;
}

// VS Code hands the provider copies of its diagnostics, not the objects the extension
// created, so fixes are found again by file, line and message. Files are keyed by
// `Uri.toString()`, which gives one spelling of a Windows drive letter.
const fixesByBundle = new Map<string, Map<string, StoredFix[]>>();

/** Replaces the fixes a bundle offers with those from its latest check. */
export function setBundleFixes(bundleRoot: string, fixes: Map<string, StoredFix[]>): void {
  fixesByBundle.set(bundleRoot, fixes);
}

export function forgetBundleFixes(bundleRoot: string): void {
  fixesByBundle.delete(bundleRoot);
}

function storedFixFor(uri: vscode.Uri, diagnostic: vscode.Diagnostic): StoredFix | undefined {
  for (const fixes of fixesByBundle.values()) {
    const match = fixes
      .get(uri.toString())
      ?.find(
        (fix) =>
          fix.line === diagnostic.range.start.line &&
          fix.message === diagnostic.message &&
          fix.kind === String(diagnostic.code),
      );
    if (match) return match;
  }
  return undefined;
}

export const QUICK_FIX_APPLIED_COMMAND = "databricksBundleInspector.quickFixApplied";

/**
 * Offers the inspector's fixes in the Quick Fix menu (the light bulb), only while the
 * file still holds the value the check read, at the place it read it.
 */
export class InspectorQuickFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      const fix = storedFixFor(document.uri, diagnostic);
      if (!fix || fix.line >= document.lineCount) continue;
      const span = locateFix(document.lineAt(fix.line).text, fix.oldText, fix.column);
      if (!span) continue;

      const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(
        document.uri,
        new vscode.Range(fix.line, span.start, fix.line, span.end),
        fix.newText,
      );
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      action.command = { command: QUICK_FIX_APPLIED_COMMAND, title: "", arguments: [fix.kind] };
      actions.push(action);
    }
    return actions;
  }
}

/**
 * True when the user has dragged to select text. Clickable rows check this so
 * finishing a selection (to copy an issue) does not also open the file.
 */
export function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

/**
 * The `data-vscode-context` for a right-click. Outside text boxes it hides VS Code's
 * own Cut/Copy/Paste, which copy nothing from this webview, so only the extension's
 * Copy shows. Text boxes keep the built-in items so Paste still works there.
 */
export function contextMenuContext(inTextBox: boolean, selectedText: string): Record<string, boolean> {
  if (inTextBox) return {};
  return {
    preventDefaultContextMenuItems: true,
    bundleInspectorHasSelection: selectedText.trim() !== "",
  };
}

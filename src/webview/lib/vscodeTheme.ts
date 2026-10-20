/**
 * The theme colours defined in index.css, for colours set from JavaScript (inline styles,
 * edges, the minimap). They are CSS variables, so they follow a theme change without a
 * re-render.
 */
export const UI_COLOR = {
  surface: "var(--ui-surface)",
  panel: "var(--ui-panel)",
  widget: "var(--ui-widget)",
  fg: "var(--ui-fg)",
  fgSoft: "var(--ui-fg-soft)",
  muted: "var(--ui-muted)",
  line: "var(--ui-line)",
  lineSoft: "var(--ui-line-soft)",
  accent: "var(--ui-accent)",
  link: "var(--ui-link)",
  error: "var(--ui-error)",
  warning: "var(--ui-warning)",
  ok: "var(--ui-ok)",
  shadow: "var(--ui-shadow)",
} as const;

export type ColorMode = "light" | "dark";

/**
 * React Flow's colour mode for the theme kind VS Code puts on `<body data-vscode-theme-kind>`.
 * Only the two light kinds are light. Without VS Code (the standalone preview) there is no
 * kind, and the view stays dark as it was designed.
 */
export function colorModeForThemeKind(kind: string | undefined): ColorMode {
  return kind === "vscode-light" || kind === "vscode-high-contrast-light" ? "light" : "dark";
}

/** The theme kind VS Code has set on this page, if any. */
export function currentThemeKind(): string | undefined {
  return typeof document === "undefined" ? undefined : document.body?.dataset.vscodeThemeKind;
}

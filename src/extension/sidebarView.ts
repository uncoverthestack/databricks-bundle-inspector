import * as vscode from "vscode";
import {
  bundleRow,
  cliRow,
  graphRow,
  problemsRow,
  profileRow,
  targetsRow,
  type ProblemsRow,
  type SettingRow,
  type SidebarBundle,
  type SidebarCli,
  type SidebarStatus,
} from "./sidebar.js";

export const BUNDLES_VIEW = "databricksBundleInspector.bundles";
export const SETTINGS_VIEW = "databricksBundleInspector.settings";
export const OPEN_TARGET_COMMAND = "databricksBundleInspector.sidebar.openTarget";
export const CHOOSE_CLI_COMMAND = "databricksBundleInspector.chooseCli";

export const OPEN_PROBLEMS_COMMAND = "databricksBundleInspector.sidebar.openProblems";
export const INSPECT_COMMAND = "databricksBundleInspector.sidebar.inspect";

/** A row of the Bundles view. Rows are things (a bundle, its graph, its problems, its targets); actions are icons on them. */
export type BundlesElement =
  | { kind: "bundle"; root: string }
  | { kind: "graph"; root: string }
  | { kind: "problems"; root: string }
  | { kind: "targets"; root: string }
  | { kind: "target"; root: string; target: string };

type RowKind = Exclude<BundlesElement["kind"], "target">;

/** VS Code's own icons and theme colours, so a status looks as it does in the Problems and Testing views. */
function statusIcon(status: SidebarStatus): vscode.ThemeIcon {
  switch (status) {
    case "checking":
      return new vscode.ThemeIcon("loading~spin");
    case "pending":
      return new vscode.ThemeIcon("circle-large-outline");
    case "passed":
      return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"));
    case "failed":
    case "errors":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground"));
    case "problems":
    case "cli_missing":
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
  }
}

function problemsIcon(status: ProblemsRow["status"]): vscode.ThemeIcon {
  if (status === "errors") return new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground"));
  if (status === "problems") return new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
  if (status === "none") return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  return new vscode.ThemeIcon("circle-large-outline");
}

export class BundlesTreeProvider implements vscode.TreeDataProvider<BundlesElement> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  // The same object for the same row, so `reveal` finds a row the view already shows.
  private readonly elements = new Map<string, BundlesElement>();

  /** `inspectIcon`: the extension's logo, the same icon as the editor title's Inspect button. */
  constructor(
    private readonly bundles: () => SidebarBundle[],
    private readonly inspectIcon: { light: vscode.Uri; dark: vscode.Uri },
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  element(kind: RowKind, root: string): BundlesElement;
  element(kind: "target", root: string, target: string): BundlesElement;
  element(kind: BundlesElement["kind"], root: string, target?: string): BundlesElement {
    const id = elementId(kind, root, target);
    const existing = this.elements.get(id);
    if (existing) return existing;
    const created: BundlesElement = kind === "target" ? { kind, root, target: target ?? "" } : { kind, root };
    this.elements.set(id, created);
    return created;
  }

  getChildren(element?: BundlesElement): BundlesElement[] {
    if (!element) return this.bundles().map((bundle) => this.element("bundle", bundle.root));
    if (element.kind === "bundle") {
      return [this.element("graph", element.root), this.element("problems", element.root), this.element("targets", element.root)];
    }
    if (element.kind === "targets") {
      const bundle = this.find(element.root);
      return bundle ? targetsRow(bundle).targets.map((item) => this.element("target", element.root, item.target)) : [];
    }
    return [];
  }

  getParent(element: BundlesElement): BundlesElement | undefined {
    if (element.kind === "target") return this.element("targets", element.root);
    if (element.kind === "bundle") return undefined;
    return this.element("bundle", element.root);
  }

  getTreeItem(element: BundlesElement): vscode.TreeItem {
    const bundle = this.find(element.root);
    if (!bundle) return new vscode.TreeItem("");
    const id = elementId(element.kind, element.root, element.kind === "target" ? element.target : undefined);
    // The ids stay the same across refreshes, so VS Code keeps what is selected and expanded.
    const item = (label: string, state = vscode.TreeItemCollapsibleState.None) => {
      const created = new vscode.TreeItem(label, state);
      created.id = id;
      created.contextValue = element.kind;
      return created;
    };

    switch (element.kind) {
      case "bundle": {
        const row = bundleRow(bundle);
        // A sole bundle starts open, so its graph and problems are in view. VS Code then
        // remembers what the user opens or closes.
        const only = this.bundles().length === 1;
        const created = item(row.label, only ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        created.description = row.description;
        created.tooltip = row.tooltip;
        created.iconPath = statusIcon(row.status);
        return created;
      }
      case "graph": {
        const row = graphRow(bundle);
        const created = item("Open Graph");
        created.description = row.description;
        created.tooltip = row.tooltip;
        created.iconPath = this.inspectIcon;
        // The graph opens as a file opens from the Explorer.
        created.command = { command: INSPECT_COMMAND, title: "Inspect Bundle", arguments: [element] };
        return created;
      }
      case "problems": {
        const row = problemsRow(bundle);
        const created = item("Problems");
        created.description = row.description;
        created.tooltip = row.tooltip;
        created.iconPath = problemsIcon(row.status);
        if (row.canOpen) {
          created.command = { command: OPEN_PROBLEMS_COMMAND, title: "Open the First Problem", arguments: [element] };
        }
        return created;
      }
      case "targets": {
        const row = targetsRow(bundle);
        const created = item(
          "Target definitions",
          row.targets.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        created.description = row.description;
        created.tooltip = row.tooltip;
        created.iconPath = new vscode.ThemeIcon("target");
        return created;
      }
      case "target": {
        const target = targetsRow(bundle).targets.find((candidate) => candidate.target === element.target);
        const created = item(element.target);
        created.description = target?.description ?? "";
        created.tooltip = `Open ${element.target} where the bundle defines it`;
        created.iconPath = new vscode.ThemeIcon("go-to-file");
        created.command = { command: OPEN_TARGET_COMMAND, title: "Open Target", arguments: [element.root, element.target] };
        return created;
      }
    }
  }

  private find(root: string): SidebarBundle | undefined {
    return this.bundles().find((bundle) => bundle.root === root);
  }
}

export type SettingsElement = "cli" | "profile";

export class SettingsTreeProvider implements vscode.TreeDataProvider<SettingsElement> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly state: () => { cli: SidebarCli; profile: string | undefined }) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getChildren(element?: SettingsElement): SettingsElement[] {
    return element ? [] : ["cli", "profile"];
  }

  getTreeItem(element: SettingsElement): vscode.TreeItem {
    const { cli, profile } = this.state();
    // A setting opens its choices, as a file opens from the Explorer.
    if (element === "cli") {
      return settingItem(cliRow(cli), "terminal", cli && !cli.ok ? "cli.missing" : "cli", CHOOSE_CLI_COMMAND);
    }
    return settingItem(profileRow(profile), "account", "profile", "databricksBundleInspector.chooseProfile");
  }
}

function settingItem(row: SettingRow, icon: string, contextValue: string, command: string): vscode.TreeItem {
  const item = new vscode.TreeItem(row.label);
  item.command = { command, title: row.label };
  item.description = row.description;
  item.tooltip = row.tooltip;
  item.iconPath = row.warning
    ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"))
    : new vscode.ThemeIcon(icon);
  item.contextValue = contextValue;
  return item;
}

function elementId(kind: BundlesElement["kind"], root: string, target: string | undefined): string {
  return kind === "target" ? `${kind}:${root}:${target ?? ""}` : `${kind}:${root}`;
}

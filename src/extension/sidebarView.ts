import * as vscode from "vscode";
import {
  bundleRow,
  checkAgainst,
  cliRow,
  profileRow,
  type SettingRow,
  type SidebarBundle,
  type SidebarCli,
  type SidebarStatus,
} from "./sidebar.js";

export const BUNDLES_VIEW = "databricksBundleInspector.bundles";
export const SETTINGS_VIEW = "databricksBundleInspector.settings";
export const OPEN_TARGET_COMMAND = "databricksBundleInspector.sidebar.openTarget";

/** A row of the Bundles view. Rows are things (bundles, targets); actions are icons on them. */
export type BundlesElement =
  | { kind: "bundle"; root: string }
  | { kind: "checkAgainst"; root: string }
  | { kind: "option"; root: string; target: string | undefined };

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
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground"));
    case "problems":
    case "cli_missing":
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
  }
}

export class BundlesTreeProvider implements vscode.TreeDataProvider<BundlesElement> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  // The same object for the same row, so `reveal` finds a row the view already shows.
  private readonly elements = new Map<string, BundlesElement>();

  constructor(private readonly bundles: () => SidebarBundle[]) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  element(kind: "bundle" | "checkAgainst", root: string): BundlesElement;
  element(kind: "option", root: string, target: string | undefined): BundlesElement;
  element(kind: BundlesElement["kind"], root: string, target?: string): BundlesElement {
    const id = elementId(kind, root, target);
    const existing = this.elements.get(id);
    if (existing) return existing;
    const created: BundlesElement = kind === "option" ? { kind, root, target } : { kind, root };
    this.elements.set(id, created);
    return created;
  }

  getChildren(element?: BundlesElement): BundlesElement[] {
    if (!element) return this.bundles().map((bundle) => this.element("bundle", bundle.root));
    if (element.kind === "bundle") return [this.element("checkAgainst", element.root)];
    if (element.kind === "checkAgainst") {
      const bundle = this.find(element.root);
      return bundle
        ? checkAgainst(bundle).options.map((option) => this.element("option", element.root, option.target))
        : [];
    }
    return [];
  }

  getParent(element: BundlesElement): BundlesElement | undefined {
    if (element.kind === "checkAgainst") return this.element("bundle", element.root);
    if (element.kind === "option") return this.element("checkAgainst", element.root);
    return undefined;
  }

  getTreeItem(element: BundlesElement): vscode.TreeItem {
    const bundle = this.find(element.root);
    if (!bundle) return new vscode.TreeItem("");
    const id = elementId(element.kind, element.root, element.kind === "option" ? element.target : undefined);

    if (element.kind === "bundle") {
      const row = bundleRow(bundle);
      const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = id;
      item.description = row.description;
      item.tooltip = row.tooltip;
      item.iconPath = statusIcon(row.status);
      item.contextValue = "bundle";
      return item;
    }

    const group = checkAgainst(bundle);
    if (element.kind === "checkAgainst") {
      const item = new vscode.TreeItem("Check against", vscode.TreeItemCollapsibleState.Collapsed);
      item.id = id;
      item.description = group.description;
      item.tooltip = group.tooltip;
      item.iconPath = new vscode.ThemeIcon("target");
      item.contextValue = "checkAgainst";
      return item;
    }

    const option = group.options.find((candidate) => candidate.target === element.target);
    const item = new vscode.TreeItem(option?.label ?? element.target ?? "");
    item.id = id;
    item.description = option?.description ?? "";
    item.iconPath = new vscode.ThemeIcon(option?.inUse ? "circle-filled" : "circle-outline");
    if (element.target === undefined) {
      item.tooltip = "The bundle's shared settings, before any target's are applied. Needs no sign-in.";
      item.contextValue = "structuralPreview";
    } else {
      // A target opens where the bundle file defines it, as a file opens from the Explorer.
      item.tooltip = `Open ${element.target} in the bundle file`;
      item.contextValue = "target";
      item.command = { command: OPEN_TARGET_COMMAND, title: "Open Target", arguments: [element.root, element.target] };
    }
    return item;
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
    if (element === "cli") {
      return settingItem(cliRow(cli), "terminal", cli && !cli.ok ? "cli.missing" : "cli");
    }
    return settingItem(profileRow(profile), "account", "profile");
  }
}

function settingItem(row: SettingRow, icon: string, contextValue: string): vscode.TreeItem {
  const item = new vscode.TreeItem(row.label);
  item.description = row.description;
  item.tooltip = row.tooltip;
  item.iconPath = row.warning
    ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"))
    : new vscode.ThemeIcon(icon);
  item.contextValue = contextValue;
  return item;
}

function elementId(kind: BundlesElement["kind"], root: string, target: string | undefined): string {
  return kind === "option" ? `${kind}:${root}:${target ?? ""}` : `${kind}:${root}`;
}

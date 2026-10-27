import { describe, expect, jest, test } from "@jest/globals";

jest.mock(
  "vscode",
  () => {
    class TreeItem {
      [key: string]: unknown;
      constructor(
        public label: string,
        public collapsibleState?: number,
      ) {}
    }
    class ThemeIcon {
      constructor(
        public id: string,
        public color?: unknown,
      ) {}
    }
    class ThemeColor {
      constructor(public id: string) {}
    }
    class EventEmitter {
      event = () => undefined;
      fire() {}
      dispose() {}
    }
    return { TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 } };
  },
  { virtual: true },
);

import { BundlesTreeProvider } from "../../../extension/sidebarView.js";
import type { SidebarBundle } from "../../../extension/sidebar.js";

const bundle = (root: string): SidebarBundle => ({
  root,
  name: root.split("/").at(-1)!,
  displayPath: `${root}/databricks.yml`,
  state: "checked",
  count: { problems: 0, notes: 0, graphOnly: 0 },
  contents: undefined,
  cliIssue: undefined,
  checking: false,
  targets: ["dev", "prod"],
});

describe("BundlesTreeProvider", () => {
  // Working out the bundles reads the disk and the Problems panel, and a render asks for
  // every row: once per row made a 150-bundle sidebar take 65 ms on each tab switch.
  test("one render reads the bundles once, however many rows it draws", () => {
    let reads = 0;
    const roots = Array.from({ length: 200 }, (_, i) => `/w/bundle${i}`);
    const tree = new BundlesTreeProvider(
      () => {
        reads++;
        return roots.map(bundle);
      },
      { light: {} as never, dark: {} as never },
    );
    const render = () => {
      const top = tree.getChildren();
      for (const element of top) tree.getTreeItem(element);
      for (const child of tree.getChildren(top[0])) {
        tree.getTreeItem(child);
        for (const target of tree.getChildren(child)) tree.getTreeItem(target);
      }
    };
    render();
    expect(reads).toBe(1);
    tree.refresh();
    render();
    expect(reads).toBe(2);
  });

  test("a render after a refresh shows the bundles as they are now", () => {
    let roots = ["/w/a"];
    const tree = new BundlesTreeProvider(() => roots.map(bundle), { light: {} as never, dark: {} as never });
    expect(tree.getChildren()).toHaveLength(1);
    roots = ["/w/a", "/w/b"];
    tree.refresh();
    const top = tree.getChildren();
    expect(top.map((element) => element.root)).toEqual(["/w/a", "/w/b"]);
    expect(tree.getTreeItem(top[1]!).label).toBe("b");
  });
});

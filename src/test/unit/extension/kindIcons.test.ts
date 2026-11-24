import { describe, expect, test } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { KIND_OF_RESOURCE_GROUP, OVERVIEW_GROUPS } from "../../../bundle/bundleOverview.js";
import { ICON_OF_KIND, RESERVED_ICONS, iconOfKind } from "../../../webview/lib/kindIcons.js";

// Issue 546: resource types show an icon in place of the type dot.
const typeDot = readFileSync(path.join(__dirname, "../../../webview/components/TypeDot.jsx"), "utf8");
const lucideIcons = path.join(__dirname, "../../../../node_modules/lucide-react/dist/esm/icons");
const kindOf = (group: string) => KIND_OF_RESOURCE_GROUP[group] ?? group;

describe("type icons", () => {
  const groups = OVERVIEW_GROUPS.flatMap((group) => group.resourceGroups);

  test.each(groups)("resource group %s has an icon", (group) => {
    expect(iconOfKind(kindOf(group))).toBeDefined();
  });

  test.each(["tables", "functions", "connections"])("%s, named by an app outside the bundle, has an icon", (kind) => {
    expect(iconOfKind(kind)).toBeDefined();
  });

  const icons = [...new Set(Object.values(ICON_OF_KIND))];

  test.each(icons)("%s is not a problem or status shape", (icon) => {
    expect(RESERVED_ICONS).not.toContain(icon);
  });

  test.each(icons.filter((icon) => icon !== "key"))("%s is drawn by TypeDot and exists in lucide-react", (icon) => {
    expect(typeDot).toContain(/^[a-z]+$/.test(icon) ? `  ${icon}: ` : `  "${icon}": `);
    expect(existsSync(path.join(lucideIcons, `${icon}.mjs`))).toBe(true);
  });

  test("a kind with no icon keeps its dot", () => {
    expect(iconOfKind("variable")).toBeUndefined();
    expect(iconOfKind(undefined)).toBeUndefined();
  });
});

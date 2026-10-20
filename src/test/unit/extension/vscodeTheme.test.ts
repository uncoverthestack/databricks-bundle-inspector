import { describe, test, expect } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { colorModeForThemeKind } from "../../../webview/lib/vscodeTheme.js";

const webview = path.join(__dirname, "../../../webview");
const read = (file: string) => readFileSync(path.join(webview, file), "utf8");

describe("colorModeForThemeKind", () => {
  test("only the two light kinds are light", () => {
    expect(colorModeForThemeKind("vscode-light")).toBe("light");
    expect(colorModeForThemeKind("vscode-high-contrast-light")).toBe("light");
    expect(colorModeForThemeKind("vscode-dark")).toBe("dark");
    expect(colorModeForThemeKind("vscode-high-contrast")).toBe("dark");
  });

  test("stays dark without VS Code, or with a kind it doesn't know", () => {
    expect(colorModeForThemeKind(undefined)).toBe("dark");
    expect(colorModeForThemeKind("")).toBe("dark");
    expect(colorModeForThemeKind("vscode-sepia")).toBe("dark");
  });
});

describe("theme colours", () => {
  const themed = [
    "App.jsx",
    "Bootstrap.jsx",
    ...readdirSync(path.join(webview, "components")).map((file) => `components/${file}`),
    "lib/issueSeverity.ts",
    "lib/kindMeta.js",
  ];

  test.each(themed)("%s sets no fixed colour", (file) => {
    const source = read(file);
    expect(source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([]);
    const palette = /\b(?:bg|text|border|ring|decoration|fill|stroke|from|to|via|outline|divide|shadow)-(?:white|black|(?:stone|slate|zinc|gray|neutral|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/g;
    expect(source.match(palette) ?? []).toEqual([]);
  });

  test("index.css reads only VS Code colours whose id has one dot", () => {
    // VS Code names each variable with replace('.', '-'), which replaces only the first dot,
    // so an id with two dots would never match the dashed name written here.
    const names = [...read("index.css").matchAll(/var\((--vscode-[^,)]+)/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(name).toMatch(/^--vscode-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?$/);
  });

  test("every kind colour has a dark value and a light-theme value", () => {
    const css = read("index.css");
    const kinds = new Set([...read("lib/kindMeta.js").matchAll(/color: "([a-z_]+)"/g)].map((match) => match[1]));
    expect(kinds.size).toBeGreaterThan(10);
    for (const kind of kinds) expect(css.split(`--kind-${kind}:`).length - 1).toBe(2);
  });

  test("every --ui colour used from JavaScript is defined in index.css", () => {
    const css = read("index.css");
    const used = new Set([...read("lib/vscodeTheme.ts").matchAll(/var\((--ui-[a-z-]+)\)/g)].map((match) => match[1]));
    for (const name of used) expect(css).toContain(`${name}:`);
  });
});

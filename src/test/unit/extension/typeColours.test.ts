import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";

// The colour rule (issue 424): red is an error, amber a warning, blue is focus, links and
// notes, green is ok. Nothing else may look like them, so a type colour must sit well away
// from each in hue, or be grey. Measured on the colours written in index.css: the view's
// own fallbacks for the reserved ones (a VS Code theme supplies its own at run time, in
// the same hues), and both shades of each type family.
const css = readFileSync(path.join(__dirname, "../../../webview/index.css"), "utf8");
const MIN_HUE_GAP = 25;

function hueAndSaturation(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation: delta / (1 - Math.abs(max + min - 1)) };
}
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360));

/** The fallback written after a VS Code colour, such as `var(--vscode-errorForeground, #f87171)`. */
const fallback = (name: string) => {
  const match = new RegExp(`--ui-${name}:[^;]*?(#[0-9a-fA-F]{6})`).exec(css);
  if (!match) throw new Error(`--ui-${name} has no fallback colour in index.css`);
  return match[1]!;
};
const RESERVED = Object.fromEntries(["error", "warning", "accent", "link", "info", "ok"].map((name) => [name, fallback(name)]));
const typeColours = [...css.matchAll(/--kind-([a-z]+):\s*(#[0-9a-fA-F]{6})/g)].map((match) => ({ family: match[1]!, hex: match[2]! }));

describe("type colours keep clear of the reserved colours", () => {
  test("the reserved colours and the type families are all found", () => {
    expect(Object.keys(RESERVED)).toHaveLength(6);
    expect(typeColours.map((colour) => colour.family).sort()).toEqual(["code", "code", "compute", "compute", "other", "other", "workload", "workload"]);
  });

  test.each(typeColours)("--kind-$family $hex is grey, or 25 degrees or more from every reserved colour", ({ family, hex }) => {
    const colour = hueAndSaturation(hex);
    if (family === "other") {
      expect(colour.saturation).toBeLessThan(0.25);
      return;
    }
    for (const [name, reserved] of Object.entries(RESERVED)) {
      const gap = hueGap(colour.hue, hueAndSaturation(reserved).hue);
      expect({ against: name, gap: Math.round(gap), ok: gap >= MIN_HUE_GAP }).toEqual({ against: name, gap: Math.round(gap), ok: true });
    }
  });

  test("the three families are told apart from each other", () => {
    const dark = typeColours.filter((colour) => colour.family !== "other").slice(0, 3).map((colour) => hueAndSaturation(colour.hex).hue);
    for (let i = 0; i < dark.length; i++) for (let j = i + 1; j < dark.length; j++) expect(hueGap(dark[i]!, dark[j]!)).toBeGreaterThanOrEqual(30);
  });
});

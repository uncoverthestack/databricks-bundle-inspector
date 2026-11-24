import { describe, expect, test } from "@jest/globals";
import { FIT_PADDING, MAX_OPEN_ZOOM, MIN_OPEN_ZOOM, START_MARGIN, openingViewport } from "../../../webview/lib/graphFit.js";

// Issue 552: a job opens fitted to the panel, within readable zoom limits.
const onScreen = (bounds: { x: number; y: number; width: number; height: number }, view: { x: number; y: number; zoom: number }) => ({
  left: bounds.x * view.zoom + view.x,
  top: bounds.y * view.zoom + view.y,
  right: (bounds.x + bounds.width) * view.zoom + view.x,
  bottom: (bounds.y + bounds.height) * view.zoom + view.y,
});

describe("where the job graph's view starts (issue 552)", () => {
  test("a job wider than the panel is zoomed out until every task is in view, and centred", () => {
    // Three columns of 260 px boxes: 920 px wide, in a 780 px panel.
    const bounds = { x: 0, y: 0, width: 920, height: 160 };
    const view = openingViewport(bounds, 780, 600);
    expect(view.zoom).toBeLessThan(1);
    expect(view.zoom).toBeGreaterThanOrEqual(MIN_OPEN_ZOOM);
    const box = onScreen(bounds, view);
    expect(box.left).toBeGreaterThan(0);
    expect(box.right).toBeLessThan(780);
    expect(box.left).toBeCloseTo(780 - box.right, 5);
    expect(box.top).toBeCloseTo(600 - box.bottom, 5);
    expect(box.right - box.left).toBeCloseTo(780 * (1 - FIT_PADDING), 5);
  });

  test("a small job is never zoomed in past full size", () => {
    const view = openingViewport({ x: 0, y: 0, width: 260, height: 48 }, 1200, 800);
    expect(view.zoom).toBe(MAX_OPEN_ZOOM);
  });

  test("a job too big to read when fitted opens at its start, at the smallest readable zoom", () => {
    const bounds = { x: 10, y: 20, width: 6000, height: 4000 };
    const view = openingViewport(bounds, 800, 600);
    expect(view.zoom).toBe(MIN_OPEN_ZOOM);
    const box = onScreen(bounds, view);
    expect(box.left).toBeCloseTo(START_MARGIN, 5);
    expect(box.top).toBeCloseTo(START_MARGIN, 5);
  });

  test("a long, flat job starts at its left end and stays centred top to bottom", () => {
    const bounds = { x: 0, y: 0, width: 6000, height: 100 };
    const view = openingViewport(bounds, 800, 600);
    const box = onScreen(bounds, view);
    expect(view.zoom).toBe(MIN_OPEN_ZOOM);
    expect(box.left).toBeCloseTo(START_MARGIN, 5);
    expect(box.top).toBeCloseTo(600 - box.bottom, 5);
  });

  test("an empty or zero-size job gives a finite view", () => {
    const view = openingViewport({ x: 0, y: 0, width: 0, height: 0 }, 800, 600);
    expect([view.x, view.y, view.zoom].every(Number.isFinite)).toBe(true);
  });
});

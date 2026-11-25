/**
 * Where the job graph's view starts (issue 552). It used to open at full size from the top-left
 * corner, so on a normal panel the right-hand tasks began out of view, and the first view
 * looked like the whole job. Now a job opens fitted to the panel: never zoomed in past full
 * size, and never below MIN_OPEN_ZOOM, where task names stop being readable. A job too big for
 * that opens at its start (left, and top when it is too tall too), and the minimap shows the rest.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Below this, a task box's 13 px name is under 8 px on screen. */
export const MIN_OPEN_ZOOM = 0.6;
/** Never zoom a small job in past full size. */
export const MAX_OPEN_ZOOM = 1;
/** Share of the panel kept free around a fitted job. Less than the recenter button leaves (0.24), so the job opens as large as it can. */
export const FIT_PADDING = 0.12;
/** Gap at the panel's edge when a big job opens at its start. */
export const START_MARGIN = 24;

export function openingViewport(bounds: Bounds, width: number, height: number): Viewport {
  const room = 1 - FIT_PADDING;
  const fit = Math.min(
    (width * room) / Math.max(bounds.width, 1),
    (height * room) / Math.max(bounds.height, 1),
    MAX_OPEN_ZOOM,
  );
  const zoom = Math.max(fit, MIN_OPEN_ZOOM);
  const centre = (panel: number, start: number, size: number) => (panel - size * zoom) / 2 - start * zoom;
  const atStart = (start: number) => START_MARGIN - start * zoom;
  const fitsAcross = bounds.width * zoom <= width * room;
  const fitsDown = bounds.height * zoom <= height * room;
  return {
    x: fitsAcross ? centre(width, bounds.x, bounds.width) : atStart(bounds.x),
    y: fitsDown ? centre(height, bounds.y, bounds.height) : atStart(bounds.y),
    zoom,
  };
}

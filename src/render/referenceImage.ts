/**
 * Where a reference image sits, and how big it is (spec §32).
 *
 * A tracing aid is never right where it lands. The scan is a little too small,
 * or the coast on it sits fifty miles east of the coast underneath, or it is
 * square where the country is long — and until now the only answer was to zoom
 * the map until the view happened to frame it and drop the file again.
 *
 * So the placement is kept as what the author actually adjusts — a centre, the
 * size it arrived at, and three multipliers — rather than as the four numbers
 * of an extent. Dragging moves the centre; the sliders move the multipliers;
 * the extent is derived from them whenever the layer needs one. Nothing here
 * touches OpenLayers, so it can be reasoned about and tested on its own.
 */

/** The multipliers, all 1 when the image has not been resized. */
export interface ReferenceSize {
  /** Uniform, driven by the Size slider. */
  scale: number;
  /** Width alone, on top of `scale`. */
  stretchX: number;
  /** Height alone, on top of `scale`. */
  stretchY: number;
}

export interface ReferencePlacement extends ReferenceSize {
  /** Centre in WGS84 degrees. */
  centre: [number, number];
  /** The width and height it was placed at, in degrees. */
  base: [number, number];
}

/** The smallest and largest a slider may take a reference image. */
export const MIN_FACTOR = 0.1;
export const MAX_FACTOR = 5;

export function clampFactor(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, v));
}

/** Start from the extent an image was dropped at. */
export function placementFromExtent(
  extent: [number, number, number, number],
): ReferencePlacement {
  const [w, s, e, n] = extent;
  return {
    centre: [(w + e) / 2, (s + n) / 2],
    base: [Math.abs(e - w), Math.abs(n - s)],
    scale: 1,
    stretchX: 1,
    stretchY: 1,
  };
}

/** The extent to draw, in WGS84 degrees. */
export function placementExtent(p: ReferencePlacement): [number, number, number, number] {
  const width = p.base[0] * p.scale * p.stretchX;
  const height = p.base[1] * p.scale * p.stretchY;
  const [cx, cy] = p.centre;
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}

/** Move the image by a delta in degrees — what a drag does. */
export function movedBy(
  p: ReferencePlacement,
  dLon: number,
  dLat: number,
): ReferencePlacement {
  if (!Number.isFinite(dLon) || !Number.isFinite(dLat)) return p;
  return { ...p, centre: [p.centre[0] + dLon, p.centre[1] + dLat] };
}

/**
 * Resize about the centre, so the part of the image the author is looking at
 * does not walk off under the slider.
 */
export function resized(p: ReferencePlacement, size: Partial<ReferenceSize>): ReferencePlacement {
  return {
    ...p,
    scale: clampFactor(size.scale ?? p.scale),
    stretchX: clampFactor(size.stretchX ?? p.stretchX),
    stretchY: clampFactor(size.stretchY ?? p.stretchY),
  };
}

/** Is this point on the image? Used to decide whether a drag grabs it. */
export function placementContains(p: ReferencePlacement, lon: number, lat: number): boolean {
  const [w, s, e, n] = placementExtent(p);
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

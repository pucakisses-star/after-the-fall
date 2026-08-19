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
 *
 * Everything is in the map's own units rather than in degrees. A rectangle of
 * longitude and latitude is not a rectangle on a projected plate — on this
 * map's Lambert azimuthal, a box drawn that way comes out a fifth too wide at
 * one edge and short at the other, which is exactly the error that made a
 * placed image the wrong size.
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
  /** Centre in the map's units. */
  centre: [number, number];
  /** The width and height it was placed at, in the map's units. */
  base: [number, number];
}

/** The smallest and largest a slider may take a reference image. */
export const MIN_FACTOR = 0.1;
export const MAX_FACTOR = 5;

/**
 * Where an image lands: at its own size, one image pixel to one screen pixel.
 *
 * A scan arrives at a resolution that means something — it was made at some
 * size, and that is the size at which its detail is real. Fitting it to the
 * window instead throws that away: a small sketch is blown up into a blur, a
 * large plate is squeezed until the lines it was traced for disappear, and
 * either way what the author sees is not what they gave the map. So the extent
 * is worked back from the view: how much ground a screen pixel covers, times
 * how many pixels the image has.
 *
 * It may well land larger than the window — a 4000 px plate on a 1200 px map
 * does — which is the honest answer. The Size slider takes it from there.
 */
export function nativeExtent(
  viewExtent: [number, number, number, number],
  viewSizePx: [number, number],
  naturalWidth: number,
  naturalHeight: number,
): [number, number, number, number] {
  const [w, s, e, n] = viewExtent;
  const [pxW, pxH] = viewSizePx;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const unitsPerPxX = pxW > 0 ? Math.abs(e - w) / pxW : 0;
  const unitsPerPxY = pxH > 0 ? Math.abs(n - s) / pxH : 0;
  // Nothing to work from — fall back to filling most of the view, as before.
  if (!unitsPerPxX || !unitsPerPxY || !naturalWidth || !naturalHeight) {
    const aspect = naturalWidth && naturalHeight ? naturalWidth / naturalHeight : 1;
    let width = Math.abs(e - w) * 0.8;
    let height = width / aspect;
    if (height > Math.abs(n - s) * 0.8) {
      height = Math.abs(n - s) * 0.8;
      width = height * aspect;
    }
    return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
  }
  const width = naturalWidth * unitsPerPxX;
  const height = naturalHeight * unitsPerPxY;
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}

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

/** The extent to draw, in the map's units. */
export function placementExtent(p: ReferencePlacement): [number, number, number, number] {
  const width = p.base[0] * p.scale * p.stretchX;
  const height = p.base[1] * p.scale * p.stretchY;
  const [cx, cy] = p.centre;
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}

/** Move the image by a delta in the map's units — what a drag does. */
export function movedBy(p: ReferencePlacement, dx: number, dy: number): ReferencePlacement {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return p;
  return { ...p, centre: [p.centre[0] + dx, p.centre[1] + dy] };
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
export function placementContains(p: ReferencePlacement, x: number, y: number): boolean {
  const [w, s, e, n] = placementExtent(p);
  return x >= w && x <= e && y >= s && y <= n;
}

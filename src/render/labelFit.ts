/**
 * Laying a political name onto the land it names (spec §10, §11, §42).
 *
 * A GIS label is an annotation: one anchor, one font size, horizontal, and a
 * halo thick enough to survive whatever it lands on. An atlas inscription is
 * part of the plate — it takes the direction of the country, opens its tracking
 * to span it, breaks onto a second line when the shape is stubby rather than
 * long, and is set large enough that you read the realm before you read anything
 * inside it.
 *
 * So this returns a *layout*, not a position: rotation, size, tracking and line
 * breaks, all derived from the polygon and from where the territory sits in the
 * hierarchy. Everything here is geometry — no canvas, no fonts — so it runs the
 * same in a test, in the demo builder and in the exporter.
 */

import type { MultiPolygon, Polygon, Position } from 'geojson';

export interface LabelLayout {
  /** Degrees, clockwise, as `MapLabel.rotation` wants. */
  rotation: number;
  fontSize: number;
  /** Letter spacing in px, as `TextStyle.tracking` wants. */
  tracking: number;
  /** The text, already broken. One entry means one line. */
  lines: string[];
}

export interface FitOptions {
  /**
   * Depth in the political hierarchy. 0 is a sovereign, 1 its members, and so
   * on. This is what makes a realm's name several times the size of the names
   * inside it, which is the difference the reference plates turn on.
   */
  depth?: number;
  /** Hard bounds, in px at the scale the map is drawn for. */
  minFontSize?: number;
  maxFontSize?: number;
  /** Longest a line may get, as a share of the axis it runs along. */
  fill?: number;
}

/**
 * Roughly how wide a glyph is relative to the font size, for a serif at these
 * sizes. Only ever used to compare a string against an available width, so it
 * needs to be about right rather than exact — and being a little generous is
 * the safe direction, since it makes labels smaller rather than overflowing.
 */
const GLYPH_WIDTH = 0.56;

/** Size ceiling per level of depth: a realm dominates, its members do not. */
const BY_DEPTH = [46, 22, 15, 12];

/**
 * The direction a territory runs, and how much room there is along and across
 * it.
 *
 * Principal component analysis over the outline, which for a polygon is just
 * the covariance of its vertices: the leading eigenvector is the axis the shape
 * is longest along. Longitude is scaled by latitude first, or every shape in
 * Canada comes out running east–west because a degree of longitude up there is
 * a third of a degree of latitude on the ground.
 *
 * Vertices rather than a sampled interior because an outline is what there is,
 * and a traced frontier's vertices are spread evenly enough along it for the
 * covariance to mean what it should.
 */
export function dominantAxis(shape: Polygon | MultiPolygon): {
  /** Degrees clockwise from east, in the range (-90, 90]. */
  angle: number;
  /** Extent along the axis and across it, in degrees of latitude. */
  along: number;
  across: number;
  /** Centre of the vertices, in lon/lat. */
  center: [number, number];
} {
  const rings = shape.type === 'Polygon' ? shape.coordinates : shape.coordinates.flat();
  const pts: Position[] = [];
  for (const ring of rings) for (const p of ring) pts.push(p);
  if (pts.length < 3) return { angle: 0, along: 0, across: 0, center: [0, 0] };

  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  const cx = sx / pts.length;
  const cy = sy / pts.length;
  const lonScale = Math.max(0.2, Math.cos((cy * Math.PI) / 180));

  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const [x, y] of pts) {
    const dx = (x - cx) * lonScale;
    const dy = y - cy;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const n = pts.length;
  xx /= n;
  xy /= n;
  yy /= n;

  // Leading eigenvector of the 2×2 covariance matrix.
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);

  // Extent along the axis and across it, measured rather than taken from the
  // eigenvalues: what the label needs is the room it actually has.
  let alongMin = Infinity;
  let alongMax = -Infinity;
  let acrossMin = Infinity;
  let acrossMax = -Infinity;
  for (const [x, y] of pts) {
    const dx = (x - cx) * lonScale;
    const dy = y - cy;
    const a = dx * ux + dy * uy;
    const b = -dx * uy + dy * ux;
    if (a < alongMin) alongMin = a;
    if (a > alongMax) alongMax = a;
    if (b < acrossMin) acrossMin = b;
    if (b > acrossMax) acrossMax = b;
  }

  // Screen y grows downward while latitude grows upward, so an axis rising to
  // the north-east is a *negative* rotation on the canvas.
  let angle = (-theta * 180) / Math.PI;
  while (angle > 90) angle -= 180;
  while (angle <= -90) angle += 180;

  return {
    angle,
    along: alongMax - alongMin,
    across: acrossMax - acrossMin,
    center: [cx, cy],
  };
}

/**
 * Break a title where a reader would.
 *
 * Never mid-word, and the halves as even as the words allow — then nudged so
 * that no line *starts* with a word leaning on the one before it. English sets
 * "Kingdom of / Hudsonia", never "Kingdom / of Hudsonia", and "Canton of Normal
 * and / Bloomington", never "Canton of Normal / and Bloomington". The small
 * word stays with what it belongs to, which means pulling the break one word
 * later rather than earlier.
 */
export function breakTitle(text: string, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (lines <= 1 || words.length < 2) return [text];

  const target = Math.ceil(words.length / lines);
  const out: string[] = [];
  let i = 0;
  while (i < words.length && out.length < lines - 1) {
    let take = Math.min(target, words.length - i);
    // Never leave the next line beginning on a leaner; take it up instead.
    while (i + take < words.length - 1 && LEANERS.has(words[i + take].toLowerCase())) take++;
    out.push(words.slice(i, i + take).join(' '));
    i += take;
  }
  if (i < words.length) out.push(words.slice(i).join(' '));
  return out.filter(Boolean);
}

const LEANERS = new Set(['of', 'the', 'de', 'del', 'du', 'des', 'la', 'le', 'and', 'von', 'van']);

/**
 * Choose a layout for a name on a shape.
 *
 * Tries the levers in the order an engraver would: set it along the country's
 * own axis at the largest size its rank allows, open the tracking if there is
 * room to spare, shrink if there is not, and only break onto a second line when
 * the shape is too stubby for one — which is the case a smaller font does not
 * fix, because the problem is the proportion rather than the size.
 */
export function fitLabel(
  text: string,
  shape: Polygon | MultiPolygon,
  metresPerDegree: number,
  opts: FitOptions = {},
): LabelLayout {
  const depth = Math.max(0, opts.depth ?? 0);
  const maxSize = opts.maxFontSize ?? BY_DEPTH[Math.min(depth, BY_DEPTH.length - 1)];
  const minSize = opts.minFontSize ?? Math.max(5, maxSize * 0.16);
  const fill = opts.fill ?? 0.82;

  const axis = dominantAxis(shape);
  // Degrees of latitude → px at the scale this is being laid out for.
  const alongPx = axis.along * metresPerDegree;
  const acrossPx = axis.across * metresPerDegree;
  if (!(alongPx > 0) || !(acrossPx > 0)) {
    return { rotation: 0, fontSize: minSize, tracking: 0, lines: [text] };
  }

  // A shape squarer than this reads better on two lines than as one long
  // inscription — a stubby country cannot carry a name across it.
  const stubby = axis.along / Math.max(1e-9, axis.across) < 1.9;
  const wanted = stubby && text.split(/\s+/).length > 1 ? 2 : 1;
  const lines = breakTitle(text, wanted);
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 1);

  const budget = alongPx * fill;
  // Height is the other constraint: two lines of a big font will not sit across
  // a narrow country however much room there is along it.
  const byHeight = (acrossPx * fill) / (lines.length * 1.25);
  let fontSize = Math.min(maxSize, byHeight, budget / (longest * GLYPH_WIDTH));
  fontSize = Math.max(minSize, fontSize);

  // Whatever room is left over after setting the type becomes tracking, which is
  // how an atlas makes a name span its country rather than sit in the middle of
  // it. Capped by rank: a barony with a short name should not end up spaced out
  // like an empire.
  const used = longest * fontSize * GLYPH_WIDTH;
  const spare = Math.max(0, budget - used);
  const maxTracking = fontSize * (depth === 0 ? 0.3 : depth === 1 ? 0.14 : 0.06);
  const tracking = Math.min(maxTracking, longest > 1 ? spare / (longest - 1) : 0);

  return {
    rotation: axis.angle,
    fontSize: Math.round(fontSize * 10) / 10,
    tracking: Math.round(tracking * 100) / 100,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Scaling a laid-out name with the map (spec §42)
// ---------------------------------------------------------------------------

/**
 * The ground scale a name is composed for: 26 px per degree of latitude, which
 * is a regional plate — one kingdom filling a window. Must match `PLATE_SCALE`
 * in the demo builder, which is where the layouts above are baked.
 */
export const PLATE_METERS_PER_PIXEL = 111_320 / 26;

/** Below this the name of a realm would vanish on a world view... */
export const MIN_LABEL_SCALE = 0.2;
/**
 * ...and above it a single letter would fill the window at street level.
 *
 * The ceiling used to be 2.5, which sounds generous and is not: it is reached
 * about one and a half zoom levels above the plate the names are composed for,
 * so every zoom past that drew every name at exactly the same size. The effect
 * was a map where names quietly stopped belonging to their territories — a
 * county filling the window with its name set in the same type as when it was
 * a thumbnail — and a "do not scale with zoom" switch that could not be seen to
 * do anything, because nothing was scaling any more.
 */
export const MAX_LABEL_SCALE = 16;

/**
 * How much bigger than its composed size an inscription is drawn at a given
 * ground scale.
 *
 * A name laid out against a shape is only correct at the scale it was laid out
 * for. Drawn at a fixed pixel size it spans two continents when you zoom out
 * and shrinks to a caption when you zoom in, which is the difference between a
 * name that belongs to a country and a name that floats over it. So the size
 * travels with the map, between the two bounds above.
 */
export function labelZoomScale(metersPerPixel: number): number {
  if (!(metersPerPixel > 0)) return 1;
  return Math.max(MIN_LABEL_SCALE, Math.min(MAX_LABEL_SCALE, PLATE_METERS_PER_PIXEL / metersPerPixel));
}

/**
 * The scale to draw a label's type at, gate included.
 *
 * One thing stops a name scaling: being pinned. It used to be two — a name that
 * did not describe a territory was held fixed whatever its flag said, on the
 * grounds that a city or a river is an annotation rather than an inscription
 * across a shape. That is a fair description of most of them and not a rule
 * worth enforcing: an ocean's name spanning its ocean at every zoom is exactly
 * an inscription, and the switch that says "do not scale with zoom" cannot
 * explain itself while it is greyed out on two thirds of the map's text.
 *
 * So every label answers the flag, and every label is created pinned — see
 * `defaultFixedSize`. Nothing scales unless it is asked to, which is the same
 * map as before with one switch that now means something everywhere.
 */
export function inscriptionScale(opts: {
  /** `MapLabel.fixedSize`. */
  pinned: boolean;
  metersPerPixel: number;
}): number {
  if (opts.pinned) return 1;
  return labelZoomScale(opts.metersPerPixel);
}

/**
 * Hold an inscription inside the plate it is drawn on.
 *
 * With the ceiling raised, a name keeps growing with its land right up to the
 * zoom where the land is the window — and a word wider than the window is not
 * an inscription, it is a fragment: "COUNTY O" with the rest off both edges.
 * The land it names has no such problem, because you can see part of a country
 * and know what it is.
 *
 * So the last word goes to the window: whatever the zoom says, the longest line
 * is drawn no wider than `fill` of the plate. Below that zoom this changes
 * nothing at all.
 */
export function fitToPlate(
  factor: number,
  text: string,
  style: ScalableText & { tracking: number },
  viewportWidth: number,
  fill = 0.92,
): number {
  if (!(viewportWidth > 0)) return factor;
  const unit = estimateLineWidth(text, style);
  if (!(unit > 0)) return factor;
  return Math.max(MIN_LABEL_SCALE, Math.min(factor, (viewportWidth * fill) / unit));
}

/**
 * How wide the longest line of a name will be, in px, before anything is drawn.
 *
 * The same estimate `fitLabel` composes with, so the layout, the zoom cap and
 * the fit test below all agree about how much room a line of this type wants
 * without a canvas being involved.
 */
export function estimateLineWidth(text: string, style: ScalableText & { tracking: number }): number {
  const longest = text.split(/\r?\n/).reduce((n, line) => Math.max(n, line.trim().length), 0);
  if (longest < 1) return 0;
  return longest * style.fontSize * GLYPH_WIDTH + (longest - 1) * Math.max(0, style.tracking);
}

/**
 * Whether a name fits the land it names (spec §13, §28).
 *
 * An atlas does not shrink a name until it fits a country the size of a full
 * stop — it leaves the name off that plate and prints it on the one that shows
 * the country. Which is the difference between a map of the Americas and a mat
 * of overlapping halos with a continent somewhere underneath.
 *
 * `room` is how wide the territory is on the plate, in px. The slack is
 * deliberate — a name may hang a little past its borders, as it does on every
 * atlas plate ever printed — and it is what keeps the name of a long thin
 * country, whose box is wider than the country is, from being dropped.
 *
 * Measured on the demo map, which is 418 states of a similar size: on a view of
 * two continents this leaves 1 name standing out of 316, at one zoom in 85 of
 * 91, and past that all of them. That is the shape an atlas has — the plate
 * showing everything names almost nothing, and the plate showing a region names
 * what is in it.
 */
export function nameFitsItsLand(
  text: string,
  style: ScalableText & { tracking: number },
  room: number,
  slack = 1.25,
): boolean {
  const unit = estimateLineWidth(text, style);
  if (!(unit > 0)) return true;
  return unit <= room * slack;
}

/** The parts of a text style that scaling touches. */
export interface ScalableText {
  fontSize: number;
  tracking: number;
  haloWidth: number;
}

/**
 * Apply the zoom scale to a composed style — what the renderer draws.
 *
 * The halo is the exception: it thins with the map so a shrunken name does not
 * become mostly outline, but it never thickens, because a halo is there to lift
 * the text off the land rather than to be part of the letterform.
 */
export function scaledText<T extends ScalableText>(style: T, factor: number): T {
  return {
    ...style,
    fontSize: style.fontSize * factor,
    tracking: style.tracking * factor,
    haloWidth: style.haloWidth * Math.min(1, factor),
  };
}

/**
 * Rewrite a style so that pinning — or unpinning — a name leaves it exactly the
 * size it is on screen at that moment.
 *
 * Pinning naively snaps a name from `size × factor` to `size`, so at a regional
 * zoom the switch labelled "do not scale with zoom" makes the name jump to 40%
 * of what you were looking at: it reads as a switch that broke something rather
 * than one that held something still. Folding the factor into the style as the
 * flag goes on, and dividing it back out as it comes off, keeps the glyphs where
 * they are through the click — what changes is what happens on the next zoom.
 *
 * `factor` is the scale the map *would* apply to this label, i.e. what
 * `labelZoomScale` says at the current view, whichever way the flag is moving.
 *
 * The fold is floored so the written size stays legible: pin a name while it
 * is drawn at 5% and the honest fold would set it to a fraction of a pixel — a
 * speck it keeps forever, and one more pin/unpin round at a different zoom
 * ratchets it further down. Below the floor the glyphs do move through the
 * click, which beats quietly writing a size no one can read or find again.
 */
const PIN_MIN_SIZE = 4;

export function pinnedText<T extends ScalableText>(style: T, factor: number, pin: boolean): T {
  const k0 = pin ? factor : 1 / factor;
  const size = Math.max(PIN_MIN_SIZE, style.fontSize * k0);
  const k = style.fontSize > 0 ? size / style.fontSize : 1;
  const halo0 = pin ? Math.min(1, factor) : 1 / Math.min(1, factor);
  const halo = Math.min(4, Math.max(0.25, halo0));
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    ...style,
    fontSize: round(size),
    tracking: round(style.tracking * k),
    haloWidth: round(style.haloWidth * halo),
  };
}

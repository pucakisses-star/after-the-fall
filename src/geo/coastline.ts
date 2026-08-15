/**
 * Putting a shape on the coastline (spec §3, §6, §55).
 *
 * Anything derived from reference data arrives at the resolution of whatever
 * drew it, and that is rarely the resolution of the coastline underneath. A
 * realm grown on a 20 km lattice overhangs the sea by half a cell; a US state
 * from the Census cartographic file describes the whole of Massachusetts,
 * Cape Cod included, in 155 vertices. Drawn over a coastline with a thousand
 * times the detail, both read the same way: a fill that cuts across every bay
 * and clips every headland, with the real shore visible outside it.
 *
 * Trimming such a shape to the land fixes that, and this is what makes it
 * affordable to do a couple of hundred times.
 */

import { clipToBox, intersection, normalizePoly } from './operations';
import type { MultiPolygon, Polygon, Position } from 'geojson';

/** One land part: its outer ring, then any rings of inland water it encloses. */
export type LandPolygon = Position[][];

export type Box = [number, number, number, number];

function boxOf(ring: Position[]): Box {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [x, y] of ring) {
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  }
  return [west, south, east, north];
}

const overlaps = (a: Box, b: Box) => a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];

/** Whether any vertex of a ring falls inside a box — the test to use when a bounding box lies. */
function anyVertexInside(ring: Position[], box: Box): boolean {
  for (const [x, y] of ring) {
    if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) return true;
  }
  return false;
}

const encloses = (outer: Box, inner: Box) =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

/** The coastline as pieces small enough to clip against cheaply, with their boxes. */
export interface LandIndex {
  parts: LandPolygon[];
  boxes: Box[];
}

/** Side of the dicing grid, in degrees. */
const LAND_TILE = 8;
/** Parts smaller than this are left whole; dicing them would not pay. */
const LAND_TILE_THRESHOLD = 2_000;

/**
 * Cut the coastline into pieces small enough to clip a realm against.
 *
 * Natural Earth ships the Americas as 1,448 parts and 164,000 vertices, but two
 * thirds of that is a single ring: the mainland, from the Beaufort Sea to Cape
 * Horn. Trimming a realm against that ring costs two seconds however small the
 * realm is, because the cost is in the coastline, not the realm — and with two
 * hundred realms to trim that is six minutes.
 *
 * So the big parts are diced on a coarse grid once, up front. Every piece is
 * then a few thousand vertices at most, a realm overlaps a handful of them, and
 * the trim costs milliseconds. The cuts run through the interior of the land and
 * the pieces abut exactly along them, so the union of the pieces is the original
 * coastline to the last vertex; nothing of the grid reaches a realm's outline.
 */
export function indexLand(land: LandPolygon[], extent: Box): LandIndex {
  const parts: LandPolygon[] = [];
  for (const poly of land) {
    if (!poly.length || poly[0].length < 4) continue;
    const box = boxOf(poly[0]);
    if (!overlaps(box, extent)) continue;
    // A ring that steps across the antimeridian has a bounding box the width of
    // the world, so every extent on Earth "overlaps" it: Afro-Eurasia is one
    // such part, and taken at its box it would be diced across the Americas at
    // 84,000 vertices a tile for a landmass that is not there. Ask its vertices
    // instead. (Same reasoning, and the same test, as clipping reference
    // geography to a projection's valid area.)
    if (box[2] - box[0] > 180 && !anyVertexInside(poly[0], extent)) continue;

    const size = poly.reduce((sum, ring) => sum + ring.length, 0);
    if (size < LAND_TILE_THRESHOLD) {
      parts.push(poly);
      continue;
    }
    // Only over ground a realm could reach, so a landmass that merely reaches
    // into the extent is not diced from end to end.
    const c0 = Math.floor(Math.max(box[0], extent[0]) / LAND_TILE);
    const c1 = Math.floor(Math.min(box[2], extent[2]) / LAND_TILE);
    const r0 = Math.floor(Math.max(box[1], extent[1]) / LAND_TILE);
    const r1 = Math.floor(Math.min(box[3], extent[3]) / LAND_TILE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const tile: Box = [c * LAND_TILE, r * LAND_TILE, (c + 1) * LAND_TILE, (r + 1) * LAND_TILE];
        const piece = clipToBox({ type: 'Polygon', coordinates: poly }, tile);
        if (!piece) continue;
        if (piece.type === 'MultiPolygon') parts.push(...piece.coordinates);
        else parts.push(piece.coordinates);
      }
    }
  }
  return { parts, boxes: parts.map((p) => boxOf(p[0])) };
}

/**
 * Trim one realm to the land beneath it.
 *
 * The realm's own neighbourhood is assembled first — the pieces of coastline
 * that reach it, each trimmed to a box a little larger than the realm — and the
 * boolean runs against that rather than against a continent.
 *
 * Shared borders survive this untouched (§6). An inland frontier lies strictly
 * inside the land, so the trim finds nothing to cut there and the vertices come
 * through unchanged; where a frontier reaches the sea, both realms cross the
 * same coastline segment, and the crossing point is computed from the same two
 * segments either way round. Neighbours therefore still agree on every border
 * they share, down to the last vertex.
 */
export function clipToLand(shape: Polygon | MultiPolygon, index: LandIndex): Polygon | MultiPolygon | null {
  const rings = shape.type === 'Polygon' ? shape.coordinates : shape.coordinates.flat();
  if (!rings.length) return null;
  const outline = boxOf(rings.flat());
  // A margin so the trimming box never grazes the shape itself: the box edges
  // are Sutherland–Hodgman artefacts and must stay clear of the answer.
  const pad = 0.5;
  const box: Box = [outline[0] - pad, outline[1] - pad, outline[2] + pad, outline[3] + pad];

  const near: number[] = [];
  for (let i = 0; i < index.parts.length; i++) {
    if (overlaps(index.boxes[i], box)) near.push(i);
  }
  if (!near.length) return null;

  // Most shapes never meet the sea, and the cheapest boolean is the one not
  // run. If no coastline passes through the shape's own bounding box then the
  // whole box lies on one side of the shore, so a single point settles it: the
  // shape is either wholly inland — return it untouched, no boolean at all —
  // or wholly at sea. Converting three thousand US counties, this is the
  // difference between clipping every one of them and clipping the few hundred
  // that actually have a coast.
  if (!coastCrosses(index, near, outline)) {
    return insideLand(index, near, rings[0][0]) ? shape : null;
  }

  const local: Position[][][] = [];
  for (const i of near) {
    if (encloses(box, index.boxes[i])) {
      local.push(index.parts[i]);
      continue;
    }
    const piece = clipToBox({ type: 'Polygon', coordinates: index.parts[i] }, box);
    if (!piece) continue;
    if (piece.type === 'MultiPolygon') local.push(...piece.coordinates);
    else local.push(piece.coordinates);
  }
  if (!local.length) return null;

  const land = normalizePoly({ type: 'MultiPolygon', coordinates: local });
  if (!land) return null;
  const clipped = intersection(shape, land);
  return clipped as Polygon | MultiPolygon | null;
}

/**
 * Is there ground under a point?
 *
 * Asked of the same diced index the trimming uses, so a box test throws away all
 * but a piece or two before any ring is walked. Lakes count as water: a ring
 * inside a landmass is a hole in it, and an island inside that lake is land
 * again, which is why the index keeps whole polygons rather than loose rings.
 */
export function landContains(index: LandIndex, point: Position): boolean {
  const near: number[] = [];
  for (let i = 0; i < index.parts.length; i++) {
    const box = index.boxes[i];
    if (point[0] < box[0] || point[0] > box[2] || point[1] < box[1] || point[1] > box[3]) continue;
    near.push(i);
  }
  return insideLand(index, near, point);
}

/**
 * Land parts from reference geometries, which is the form `indexLand` wants.
 *
 * Kept as polygons rather than flattened to rings because a trim has to know
 * which ring is a hole in which — an island in a lake is land, and the lake it
 * sits in is not.
 */
export function landPolygonsOf(geometries: (Polygon | MultiPolygon)[]): LandPolygon[] {
  const out: LandPolygon[] = [];
  for (const g of geometries) {
    for (const poly of g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) out.push(poly);
  }
  return out;
}

/** The box a set of shapes occupies, with a margin, for indexing the coast around them. */
export function boundsOf(shapes: (Polygon | MultiPolygon)[], pad = 1): Box {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const g of shapes) {
    for (const ring of g.type === 'Polygon' ? g.coordinates : g.coordinates.flat()) {
      const b = boxOf(ring);
      box[0] = Math.min(box[0], b[0]);
      box[1] = Math.min(box[1], b[1]);
      box[2] = Math.max(box[2], b[2]);
      box[3] = Math.max(box[3], b[3]);
    }
  }
  if (!Number.isFinite(box[0])) return [-180, -90, 180, 90];
  return [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
}

/**
 * Does any coastline pass through this box?
 *
 * Deliberately conservative — it compares each segment's own box rather than
 * testing a real crossing, so it can answer yes for a segment that merely
 * passes nearby. That costs an unnecessary trim now and then, which is the
 * right way round: a false yes is slow, a false no would be wrong.
 */
function coastCrosses(index: LandIndex, near: number[], box: Box): boolean {
  for (const i of near) {
    for (const ring of index.parts[i]) {
      for (let k = 0; k < ring.length - 1; k++) {
        const [ax, ay] = ring[k];
        const [bx, by] = ring[k + 1];
        if (ax < box[0] && bx < box[0]) continue;
        if (ax > box[2] && bx > box[2]) continue;
        if (ay < box[1] && by < box[1]) continue;
        if (ay > box[3] && by > box[3]) continue;
        return true;
      }
    }
  }
  return false;
}

/** Even–odd crossing count, so a point in a lake inside an island reads as water. */
function inRing(ring: Position[], [x, y]: Position): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether a point sits on land, holes counted as the water they are. */
function insideLand(index: LandIndex, near: number[], point: Position): boolean {
  for (const i of near) {
    const [outer, ...holes] = index.parts[i];
    if (!inRing(outer, point)) continue;
    if (holes.some((h) => inRing(h, point))) continue;
    return true;
  }
  return false;
}

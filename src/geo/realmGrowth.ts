/**
 * Grow realm shapes from seed points across land (spec §3, §55).
 *
 * A political map of an imagined world should not look like a modern
 * administrative map with the labels changed. Real polities do not stop at
 * state lines: they spread from a seat of power along coasts and rivers until
 * they meet a rival or run out of reach, they bulge and pinch, and the ground
 * between them is nobody's. Dissolving modern subdivisions can never produce
 * that, because every border it can draw is a border someone else already drew.
 *
 * So the shapes here are grown instead. Land is rasterised to a lattice, each
 * realm claims outward from its capital at a rate set by its strength, and the
 * frontier between two realms falls where their claims meet — perturbed by a
 * deterministic noise field so the line wanders the way a real frontier does.
 * A realm stops when it has taken the territory its strength allows, which
 * leaves genuine wilderness rather than filling the continent edge to edge.
 * The lattice edges are then traced into rings and rounded off, so nothing of
 * the grid survives into the finished outline.
 *
 * Nothing here knows about any particular continent or set of realms.
 */

import { clipToBox, intersection, normalizePoly } from './operations';
import type { MultiPolygon, Polygon, Position } from 'geojson';

/** One land part: its outer ring, then any rings of inland water it encloses. */
export type LandPolygon = Position[][];

export interface RealmSeed {
  id: string;
  /**
   * Where the realm grows from. The first is its capital; extra seeds let a
   * realm that straddles a strait or a mountain range start on both sides
   * rather than having to reach around.
   */
  seeds: [number, number][];
  /** Relative reach. 1 is an ordinary kingdom; a city-state is well under it. */
  weight: number;
}

export interface GrowthOptions {
  /** WGS84 [w, s, e, n] to grow within. */
  extent: [number, number, number, number];
  /** Lattice spacing in degrees. Smaller is finer and slower. */
  cellSize: number;
  /**
   * Share of the land to claim in total, 0–1. The remainder is wilderness —
   * the white space between realms that makes a map of a collapsed world read
   * as one.
   */
  coverage: number;
  /**
   * Strength of the terrain-like cost field, 0–1. This is what stops the map
   * being a Voronoi diagram: without it every frontier settles on the straight
   * bisector between two seats.
   */
  roughness: number;
  /** Wavelength of that field, in cells. Large means long, sweeping frontiers. */
  grain: number;
  /**
   * Extra cost to enter a cell a watercourse runs through. Rivers are the
   * boundary of first resort in the real world, and a map whose borders ignore
   * them never looks like one.
   */
  riverCost: number;
  /**
   * Discount for a cell on the shoreline. Power travelled by water: realms
   * spread along a coast far faster than into the interior, which is where the
   * long thin coastal strips on a real map come from.
   */
  coastBonus: number;
  /** Rounds of corner-cutting applied to the traced outline. */
  smoothing: number;
  /**
   * Trim every realm to the coastline once it has been grown.
   *
   * On by default, and the only reason to turn it off is speed. A realm claims
   * whole lattice cells, so its outline runs up to half a cell — twenty
   * kilometres — out to sea, and rounding it off pushes it further; the result
   * is a shape that ignores the very coastline it is supposed to sit on.
   * Clipping puts the sea-facing edge of a realm exactly on the shore, at the
   * full detail of whatever land data was passed in.
   */
  clipToCoast: boolean;
}

export const DEFAULT_GROWTH: Omit<GrowthOptions, 'extent'> = {
  // 0.18° is about 20 km, which is fine enough that the lattice does not show
  // as rounded steps once you zoom past a continental view, and coarse enough
  // that the whole New World grows in well under a second.
  cellSize: 0.18,
  coverage: 0.62,
  roughness: 0.8,
  grain: 14,
  riverCost: 1.4,
  coastBonus: 0.45,
  smoothing: 4,
  clipToCoast: true,
};

/**
 * Deterministic hash in [0, 1) from lattice coordinates.
 *
 * Deterministic matters twice over: the same map must come out of the same
 * inputs every time it is built, and the tests have to be able to assert on
 * the result at all.
 */
function hash(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Value noise: hashes on a coarse lattice, smoothly interpolated between. */
function valueNoise(x: number, y: number, salt: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smoothstep(x - xi);
  const ty = smoothstep(y - yi);
  const a = hash(xi, yi, salt);
  const b = hash(xi + 1, yi, salt);
  const c = hash(xi, yi + 1, salt);
  const d = hash(xi + 1, yi + 1, salt);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * Fractal noise — several octaves of value noise, each finer and fainter.
 *
 * The octaves are the whole point. White noise per cell averages out over any
 * distance, so a frontier perturbed by it still ends up on the bisector between
 * two seats; that is why the first version of this produced hexagons. Noise
 * that is *correlated* across tens of cells makes whole stretches of frontier
 * bulge one way, which is what a real border looks like.
 */
function fbm(x: number, y: number, salt: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let octave = 0; octave < 4; octave++) {
    sum += valueNoise(x * freq, y * freq, salt + octave * 7919) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum / 0.9375; // normalise back to roughly 0–1
}

/** A tiny binary heap; the growth front is the only thing that needs one. */
class Frontier {
  private cost: number[] = [];
  private cell: number[] = [];
  private realm: number[] = [];

  get size(): number {
    return this.cost.length;
  }

  push(cost: number, cell: number, realm: number): void {
    this.cost.push(cost);
    this.cell.push(cell);
    this.realm.push(realm);
    let i = this.cost.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cost[parent] <= this.cost[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): { cost: number; cell: number; realm: number } {
    const top = { cost: this.cost[0], cell: this.cell[0], realm: this.realm[0] };
    const last = this.cost.length - 1;
    this.swap(0, last);
    this.cost.pop();
    this.cell.pop();
    this.realm.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let small = i;
      if (l < this.cost.length && this.cost[l] < this.cost[small]) small = l;
      if (r < this.cost.length && this.cost[r] < this.cost[small]) small = r;
      if (small === i) break;
      this.swap(small, i);
      i = small;
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.cost[a], this.cost[b]] = [this.cost[b], this.cost[a]];
    [this.cell[a], this.cell[b]] = [this.cell[b], this.cell[a]];
    [this.realm[a], this.realm[b]] = [this.realm[b], this.realm[a]];
  }
}

interface Lattice {
  cols: number;
  rows: number;
  cell: number;
  west: number;
  south: number;
  /** 1 where the cell centre is on land. */
  land: Uint8Array;
  landCount: number;
}

/**
 * Mark every lattice cell whose centre falls on land.
 *
 * Scanline fill rather than a point-in-polygon test per cell: the land file is
 * one feature holding thousands of rings, and testing a quarter of a million
 * cells against all of them is minutes of work for an answer a single pass over
 * the edges gives in milliseconds.
 */
function rasterize(rings: Position[][], extent: [number, number, number, number], cell: number): Lattice {
  const [west, south, east, north] = extent;
  const cols = Math.max(1, Math.ceil((east - west) / cell));
  const rows = Math.max(1, Math.ceil((north - south) / cell));
  const land = new Uint8Array(cols * rows);

  // Bucket each edge into the rows its span crosses.
  const rowEdges: number[][] = Array.from({ length: rows }, () => []);
  const x1: number[] = [];
  const y1: number[] = [];
  const x2: number[] = [];
  const y2: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = ring[i][0];
      const ay = ring[i][1];
      const bx = ring[i + 1][0];
      const by = ring[i + 1][1];
      if (ay === by) continue; // horizontal edges never cross a scanline
      const lo = Math.min(ay, by);
      const hi = Math.max(ay, by);
      if (hi < south || lo > north) continue;
      const r0 = Math.max(0, Math.ceil((lo - south) / cell - 0.5));
      const r1 = Math.min(rows - 1, Math.floor((hi - south) / cell - 0.5));
      if (r1 < r0) continue;
      const index = x1.length;
      x1.push(ax);
      y1.push(ay);
      x2.push(bx);
      y2.push(by);
      for (let r = r0; r <= r1; r++) rowEdges[r].push(index);
    }
  }

  let landCount = 0;
  const crossings: number[] = [];
  for (let r = 0; r < rows; r++) {
    const y = south + (r + 0.5) * cell;
    crossings.length = 0;
    for (const e of rowEdges[r]) {
      // Half-open comparison, so a vertex exactly on the scanline counts once.
      if (y1[e] <= y === y2[e] <= y) continue;
      crossings.push(x1[e] + ((y - y1[e]) * (x2[e] - x1[e])) / (y2[e] - y1[e]));
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const c0 = Math.max(0, Math.ceil((crossings[i] - west) / cell - 0.5));
      const c1 = Math.min(cols - 1, Math.floor((crossings[i + 1] - west) / cell - 0.5));
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        if (!land[k]) {
          land[k] = 1;
          landCount++;
        }
      }
    }
  }

  return { cols, rows, cell, west, south, land, landCount };
}

/**
 * The price of entering each land cell.
 *
 * Three things go into it, and between them they are what make the frontiers
 * look drawn rather than computed:
 *
 *  • fractal noise, standing in for the terrain nobody has modelled — ridges of
 *    expensive ground that both neighbours stop at, so the border between them
 *    wanders over hundreds of kilometres instead of running straight;
 *  • rivers, which cost extra to cross, so borders settle onto them the way
 *    real ones do;
 *  • coasts, which are cheap, so a realm runs along a shoreline far faster than
 *    it pushes inland — the origin of every long thin coastal state on a real
 *    map.
 */
function costField(grid: Lattice, options: GrowthOptions, riverLines: Position[][]): Float32Array {
  const { cols, rows, cell, west, south, land } = grid;
  const field = new Float32Array(cols * rows);
  const grain = Math.max(1, options.grain);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!land[i]) continue;
      const terrain = 1 + options.roughness * (fbm(c / grain, r / grain, 1013) - 0.5) * 2;
      // A cell with open water on any side is a shore.
      const coastal =
        (c > 0 && !land[i - 1]) ||
        (c + 1 < cols && !land[i + 1]) ||
        (r > 0 && !land[i - cols]) ||
        (r + 1 < rows && !land[i + cols]);
      field[i] = Math.max(0.12, terrain - (coastal ? options.coastBonus : 0));
    }
  }

  // Stamp the watercourses on afterwards, so a river crossing stays expensive
  // even where it runs along a cheap shore.
  if (options.riverCost > 0) {
    for (const line of riverLines) {
      for (let k = 0; k < line.length - 1; k++) {
        const [ax, ay] = line[k];
        const [bx, by] = line[k + 1];
        // Walk the segment at half-cell steps; rivers are far finer than the
        // lattice, so sampling the endpoints alone would leave gaps a realm
        // could pour through.
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell * 0.5)));
        for (let t = 0; t <= steps; t++) {
          const x = ax + ((bx - ax) * t) / steps;
          const y = ay + ((by - ay) * t) / steps;
          const c = Math.round((x - west) / cell - 0.5);
          const r = Math.round((y - south) / cell - 0.5);
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
          const i = r * cols + c;
          if (land[i]) field[i] += options.riverCost;
        }
      }
    }
  }

  return field;
}

/** The lattice cell a coordinate falls in, or the nearest land cell to it. */
function cellFor(grid: Lattice, lon: number, lat: number): number | null {
  const c = Math.round((lon - grid.west) / grid.cell - 0.5);
  const r = Math.round((lat - grid.south) / grid.cell - 0.5);
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return null;
  const here = r * grid.cols + c;
  if (grid.land[here]) return here;
  // A capital on the coast can land in a sea cell; take the nearest land.
  for (let radius = 1; radius <= 6; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= grid.rows || cc >= grid.cols) continue;
        const k = rr * grid.cols + cc;
        if (grid.land[k]) return k;
      }
    }
  }
  return null;
}

type Box = [number, number, number, number];

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
interface LandIndex {
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
function indexLand(land: LandPolygon[], extent: Box): LandIndex {
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
function clipToLand(shape: Polygon | MultiPolygon, index: LandIndex): Polygon | MultiPolygon | null {
  const rings = shape.type === 'Polygon' ? shape.coordinates : shape.coordinates.flat();
  if (!rings.length) return null;
  const outline = boxOf(rings.flat());
  // A margin so the trimming box never grazes the realm itself: the box edges
  // are Sutherland–Hodgman artefacts and must stay clear of the answer.
  const pad = 0.5;
  const box: Box = [outline[0] - pad, outline[1] - pad, outline[2] + pad, outline[3] + pad];

  const local: Position[][][] = [];
  for (let i = 0; i < index.parts.length; i++) {
    if (!overlaps(index.boxes[i], box)) continue;
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

export interface GrowthResult {
  /** Realm id → its outline, or absent when nothing could be grown for it. */
  shapes: Map<string, Polygon | MultiPolygon>;
  /** Land cells claimed by each realm, for reporting. */
  claimed: Map<string, number>;
  /** Share of land left to nobody, 0–1. */
  wilderness: number;
}

export function growRealms(
  land: LandPolygon[],
  seeds: RealmSeed[],
  options: GrowthOptions,
  riverLines: Position[][] = [],
): GrowthResult {
  // The lattice only cares which side of a line it is on, so it takes the rings
  // flat; the clipping stage needs to know which ring is a hole in which, so it
  // gets the polygons as they came.
  const grid = rasterize(land.flat(), options.extent, options.cellSize);
  const owner = new Int32Array(grid.cols * grid.rows).fill(-1);
  const cost = costField(grid, options, riverLines);

  // Area, not reach, scales with the square of a realm's strength. Sharing the
  // budget out in proportion to weight alone gave every realm much the same
  // size — a tessellation of similar cells — when what a real map has is a few
  // sprawling powers among many small ones.
  const totalArea = seeds.reduce((sum, s) => sum + s.weight * s.weight, 0) || 1;
  const budget = grid.landCount * Math.max(0, Math.min(1, options.coverage));
  const quota = seeds.map((s) => Math.max(1, Math.round((budget * s.weight * s.weight) / totalArea)));
  const taken = new Array(seeds.length).fill(0);

  const frontier = new Frontier();
  seeds.forEach((seed, index) => {
    for (const [lon, lat] of seed.seeds) {
      const cell = cellFor(grid, lon, lat);
      if (cell !== null) frontier.push(0, cell, index);
    }
  });

  const { cols, rows } = grid;
  while (frontier.size > 0) {
    const top = frontier.pop();
    const { cell, realm } = top;
    if (owner[cell] !== -1) continue;
    if (taken[realm] >= quota[realm]) continue;
    owner[cell] = realm;
    taken[realm]++;

    const r = (cell / cols) | 0;
    const c = cell - r * cols;
    // A step costs the terrain's price divided by the realm's strength. The
    // terrain is shared between realms, which is what makes two of them agree
    // on where the frontier lies — along a river, around a mountain — rather
    // than meeting on the bisector between their seats.
    const reach = 1 / Math.max(0.05, seeds[realm].weight);
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as [number, number][]) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const next = rr * cols + cc;
      if (!grid.land[next] || owner[next] !== -1) continue;
      frontier.push(top.cost + reach * cost[next], next, realm);
    }
  }

  const shapes = new Map<string, Polygon | MultiPolygon>();
  const claimed = new Map<string, number>();
  const coast = options.clipToCoast ? indexLand(land, options.extent) : null;
  seeds.forEach((seed, index) => {
    claimed.set(seed.id, taken[index]);
    const outline = traceRealm(grid, owner, index, options.smoothing);
    if (!outline) return;
    // A realm whose whole claim is trimmed away had nothing but the sea-side
    // overhang of a cell or two, and is better absent than drawn as a slick.
    const final = coast ? clipToLand(outline, coast) : outline;
    if (final) shapes.set(seed.id, final);
  });

  const held = taken.reduce((a, b) => a + b, 0);
  return { shapes, claimed, wilderness: 1 - held / Math.max(1, grid.landCount) };
}

/**
 * Turn one realm's claimed cells into a polygon.
 *
 * Every lattice edge with the realm on one side and anything else on the other
 * is a piece of that realm's border; stitching those pieces end to end gives its
 * rings, which are then rounded so the lattice does not show through.
 */
function traceRealm(
  grid: Lattice,
  owner: Int32Array,
  realm: number,
  smoothing: number,
): Polygon | MultiPolygon | null {
  const { cols, rows, cell, west, south } = grid;
  // Edges keyed by their start corner, each carrying who is on the *other* side.
  // That label is what makes the shared-border handling below possible.
  const next = new Map<string, { to: [number, number]; other: number }[]>();
  const key = (p: [number, number]) => `${p[0]},${p[1]}`;
  const corner = (c: number, r: number): [number, number] => [
    Number((west + c * cell).toFixed(6)),
    Number((south + r * cell).toFixed(6)),
  ];
  const ownerAt = (rr: number, cc: number) =>
    rr < 0 || cc < 0 || rr >= rows || cc >= cols ? -2 : owner[rr * cols + cc];

  const addEdge = (a: [number, number], b: [number, number], other: number) => {
    const list = next.get(key(a));
    if (list) list.push({ to: b, other });
    else next.set(key(a), [{ to: b, other }]);
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (owner[r * cols + c] !== realm) continue;
      // Wound so the interior is always on the left, which makes the outer ring
      // counter-clockwise and any enclave clockwise — the GeoJSON convention.
      const n = ownerAt(r - 1, c);
      const e = ownerAt(r, c + 1);
      const s = ownerAt(r + 1, c);
      const w = ownerAt(r, c - 1);
      if (n !== realm) addEdge(corner(c, r), corner(c + 1, r), n);
      if (e !== realm) addEdge(corner(c + 1, r), corner(c + 1, r + 1), e);
      if (s !== realm) addEdge(corner(c + 1, r + 1), corner(c, r + 1), s);
      if (w !== realm) addEdge(corner(c, r + 1), corner(c, r), w);
    }
  }

  const rings: Position[][] = [];
  while (next.size > 0) {
    const startKey = next.keys().next().value as string;
    const start = startKey.split(',').map(Number) as [number, number];
    const ring: Position[] = [start];
    const neighbours: number[] = [];
    let at = start;
    for (;;) {
      const options = next.get(key(at));
      if (!options || options.length === 0) break;
      const step = options.pop()!;
      if (options.length === 0) next.delete(key(at));
      ring.push(step.to);
      neighbours.push(step.other);
      at = step.to;
      if (key(at) === startKey) break;
    }
    // A ring that encloses less than a cell is a tracing artefact — two claimed
    // cells meeting at a corner leave a zero-width loop — and drawing it puts a
    // hairline across the map with no territory behind it.
    const closed = closeRing(ring);
    if (closed.length >= 4 && Math.abs(signedArea(closed)) > cell * cell * 0.25) {
      rings.push(dressRing(closed, neighbours, cell, smoothing));
    }
  }
  if (rings.length === 0) return null;

  return assemble(rings);
}

/**
 * Turn a traced ring into a drawn one, without breaking shared borders.
 *
 * The naive approach — simplify the whole ring, then round it — pulls every
 * realm away from its neighbours, because Douglas–Peucker keeps different
 * vertices depending on where in the ring it starts. Two realms then disagree
 * about a border they share, and the map grows a white seam along every
 * frontier.
 *
 * So the ring is first cut into arcs at the points where the neighbour on the
 * other side changes — the junctions where three regions meet. Each arc is
 * simplified and rounded on its own with its endpoints pinned. Both realms
 * either side of an arc see the same run of points (one of them reversed), and
 * both simplification and corner-cutting give the same answer on a reversed
 * polyline, so the two results are identical and the border stays shared.
 */
function dressRing(ring: Position[], neighbours: number[], cell: number, smoothing: number): Position[] {
  if (neighbours.length !== ring.length - 1) {
    // A ring that did not close cleanly; treat it as one arc rather than guess.
    return smoothOpen(simplifyOpen(ring, cell * 1.3), smoothing);
  }

  // Cut points: where the neighbouring region changes between one edge and the
  // next, walking the closed ring.
  const cuts: number[] = [];
  for (let i = 0; i < neighbours.length; i++) {
    const prev = neighbours[(i - 1 + neighbours.length) % neighbours.length];
    if (neighbours[i] !== prev) cuts.push(i);
  }

  // A ring with a single neighbour all the way round — an island, or a realm
  // entirely surrounded by wilderness — has no junctions to pin.
  if (cuts.length === 0) return smoothRing(simplifyRing(ring, cell * 1.3), smoothing);

  const out: Position[] = [];
  for (let k = 0; k < cuts.length; k++) {
    const from = cuts[k];
    const to = cuts[(k + 1) % cuts.length];
    const arc: Position[] = [];
    for (let i = from; ; i = (i + 1) % neighbours.length) {
      arc.push(ring[i]);
      if (i === to) break;
    }
    const dressed = smoothOpen(simplifyOpen(arc, cell * 1.3), smoothing);
    // Drop the shared endpoint so arcs join without a duplicate vertex.
    out.push(...(k === 0 ? dressed : dressed.slice(1)));
  }
  return closeRing(out);
}

/** Chaikin on an open polyline, with both ends pinned so arcs stay joined. */
function smoothOpen(line: Position[], rounds: number): Position[] {
  let current = line;
  for (let round = 0; round < rounds && current.length > 2; round++) {
    const out: Position[] = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      const a = current[i];
      const b = current[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(current[current.length - 1]);
    current = out;
  }
  return current.map((p) => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))]);
}

/**
 * Ramer–Douglas–Peucker on an open polyline, endpoints always kept.
 *
 * Exported because its reversal symmetry is not an implementation detail but the
 * thing the shared-border guarantee rests on, and is worth a test of its own.
 *
 * Iterative rather than recursive: a traced arc can be thousands of points and
 * the recursive form overflows the stack on exactly the shapes that need it.
 *
 * Symmetric under reversal, which is what lets two neighbours simplify a shared
 * arc independently and still agree on it — and the tie-break below is why. A
 * traced frontier is a staircase, so two points are very often *exactly* the
 * same distance from the chord, and "keep the first one found" resolves that
 * differently depending on which end you start from. Two realms then keep
 * different vertices along a border they share and their fills overlap. Picking
 * the lexicographically smaller point instead depends on the points and not on
 * the direction of travel, so both neighbours reach the same answer.
 */
export function simplifyOpen(line: Position[], tolerance: number): Position[] {
  if (line.length < 3) return line.slice();
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;

  const stack: [number, number][] = [[0, line.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    let far = -1;
    let farDist = tol2;
    const [ax, ay] = line[first];
    const [bx, by] = line[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = line[i];
      let d2: number;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d2 > farDist) {
        farDist = d2;
        far = i;
      } else if (d2 === farDist && far !== -1 && before(line[i], line[far])) {
        far = i;
      }
    }
    if (far === -1) continue;
    keep[far] = 1;
    stack.push([first, far], [far, last]);
  }

  const out: Position[] = [];
  for (let i = 0; i < line.length; i++) if (keep[i]) out.push(line[i]);
  return out;
}

/** Lexicographic order on points; a tie-break that does not know which way it came. */
const before = (a: Position, b: Position) => (a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1]);

/** Whole-ring simplify, for a ring with no junctions to pin. */
function simplifyRing(ring: Position[], tolerance: number): Position[] {
  const open = simplifyOpen(ring.slice(0, -1), tolerance);
  return closeRing(open.length >= 3 ? open : ring.slice(0, -1));
}

function closeRing(ring: Position[]): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

/**
 * Chaikin corner-cutting, run as a closed loop.
 *
 * The traced outline is all right angles. Two or three rounds of this leave a
 * border that reads as drawn rather than as pixels, without moving it far enough
 * to cross a coastline.
 */
function smoothRing(ring: Position[], rounds: number): Position[] {
  let current = ring.slice(0, -1);
  for (let round = 0; round < rounds && current.length > 3; round++) {
    const out: Position[] = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    current = out;
  }
  return closeRing(current.map((p) => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))]));
}

/** Signed area; positive is counter-clockwise. */
function signedArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function ringContains(outer: Position[], point: Position): boolean {
  let inside = false;
  for (let i = 0, j = outer.length - 2; i < outer.length - 1; j = i++) {
    const [xi, yi] = outer[i];
    const [xj, yj] = outer[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Group traced rings into polygons, putting each enclave inside its container. */
function assemble(rings: Position[][]): Polygon | MultiPolygon {
  const outers: Position[][] = [];
  const holes: Position[][] = [];
  for (const ring of rings) (signedArea(ring) >= 0 ? outers : holes).push(ring);
  if (outers.length === 0) return { type: 'Polygon', coordinates: [rings[0]] };

  const polygons: Position[][][] = outers.map((o) => [o]);
  for (const hole of holes) {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      if (!ringContains(outers[i], hole[0])) continue;
      const area = Math.abs(signedArea(outers[i]));
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    if (best >= 0) polygons[best].push(hole);
  }

  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

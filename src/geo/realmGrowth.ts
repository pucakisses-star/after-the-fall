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

import type { MultiPolygon, Polygon, Position } from 'geojson';

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
  /** How far a frontier wanders from the midpoint between two capitals, 0–1. */
  roughness: number;
  /** Rounds of corner-cutting applied to the traced outline. */
  smoothing: number;
}

export const DEFAULT_GROWTH: Omit<GrowthOptions, 'extent'> = {
  // 0.18° is about 20 km, which is fine enough that the lattice does not show
  // as rounded steps once you zoom past a continental view, and coarse enough
  // that the whole New World grows in well under a second.
  cellSize: 0.18,
  coverage: 0.62,
  roughness: 0.55,
  smoothing: 4,
};

/**
 * Deterministic value noise in [0, 1) from lattice coordinates.
 *
 * Deterministic matters twice over: the same map must come out of the same
 * inputs every time it is built, and the tests have to be able to assert on
 * the result at all.
 */
function noise(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
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

export interface GrowthResult {
  /** Realm id → its outline, or absent when nothing could be grown for it. */
  shapes: Map<string, Polygon | MultiPolygon>;
  /** Land cells claimed by each realm, for reporting. */
  claimed: Map<string, number>;
  /** Share of land left to nobody, 0–1. */
  wilderness: number;
}

export function growRealms(
  landRings: Position[][],
  seeds: RealmSeed[],
  options: GrowthOptions,
): GrowthResult {
  const grid = rasterize(landRings, options.extent, options.cellSize);
  const owner = new Int32Array(grid.cols * grid.rows).fill(-1);

  const totalWeight = seeds.reduce((sum, s) => sum + s.weight, 0) || 1;
  const budget = grid.landCount * Math.max(0, Math.min(1, options.coverage));
  const quota = seeds.map((s) => Math.max(1, Math.round((budget * s.weight) / totalWeight)));
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
    const { cost, cell, realm } = frontier.pop();
    if (owner[cell] !== -1) continue;
    if (taken[realm] >= quota[realm]) continue;
    owner[cell] = realm;
    taken[realm]++;

    const r = (cell / cols) | 0;
    const c = cell - r * cols;
    // A step costs less for a stronger realm, and the noise term is what keeps
    // the frontier from settling into a straight line between two capitals.
    const step = 1 / Math.max(0.05, seeds[realm].weight);
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
      const wobble = 1 + options.roughness * (noise(cc, rr, realm) - 0.35);
      frontier.push(cost + step * wobble, next, realm);
    }
  }

  const shapes = new Map<string, Polygon | MultiPolygon>();
  const claimed = new Map<string, number>();
  seeds.forEach((seed, index) => {
    claimed.set(seed.id, taken[index]);
    const outline = traceRealm(grid, owner, index, options.smoothing);
    if (outline) shapes.set(seed.id, outline);
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
  // Edges keyed by their start corner, so a ring can be walked by lookup.
  const next = new Map<string, [number, number][]>();
  const key = (p: [number, number]) => `${p[0]},${p[1]}`;
  const corner = (c: number, r: number): [number, number] => [
    Number((west + c * cell).toFixed(6)),
    Number((south + r * cell).toFixed(6)),
  ];

  const addEdge = (a: [number, number], b: [number, number]) => {
    const list = next.get(key(a));
    if (list) list.push(b);
    else next.set(key(a), [b]);
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (owner[r * cols + c] !== realm) continue;
      const mine = (rr: number, cc: number) =>
        rr >= 0 && cc >= 0 && rr < rows && cc < cols && owner[rr * cols + cc] === realm;
      // Wound so the interior is always on the left, which makes the outer ring
      // counter-clockwise and any enclave clockwise — the GeoJSON convention.
      if (!mine(r - 1, c)) addEdge(corner(c, r), corner(c + 1, r));
      if (!mine(r, c + 1)) addEdge(corner(c + 1, r), corner(c + 1, r + 1));
      if (!mine(r + 1, c)) addEdge(corner(c + 1, r + 1), corner(c, r + 1));
      if (!mine(r, c - 1)) addEdge(corner(c, r + 1), corner(c, r));
    }
  }

  const rings: Position[][] = [];
  while (next.size > 0) {
    const startKey = next.keys().next().value as string;
    const start = startKey.split(',').map(Number) as [number, number];
    const ring: Position[] = [start];
    let at = start;
    for (;;) {
      const options = next.get(key(at));
      if (!options || options.length === 0) break;
      const to = options.pop()!;
      if (options.length === 0) next.delete(key(at));
      ring.push(to);
      at = to;
      if (key(at) === startKey) break;
    }
    // A ring that encloses less than a cell is a tracing artefact — two claimed
    // cells meeting at a corner leave a zero-width loop — and drawing it puts a
    // hairline across the map with no territory behind it.
    const closed = closeRing(ring);
    if (closed.length >= 4 && Math.abs(signedArea(closed)) > cell * cell * 0.25) {
      rings.push(closed);
    }
  }
  if (rings.length === 0) return null;

  const smoothed = rings.map((ring) => smoothRing(ring, smoothing));
  return assemble(smoothed);
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

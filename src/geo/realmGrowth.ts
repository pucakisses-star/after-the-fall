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

import { clipToLand, indexLand, type LandPolygon } from './coastline';
import { indexRivers, snapToRivers, type RiverIndex } from './riverSnap';

/** Everything the frontier dressing needs to put a border on a river. */
interface RiverBorders {
  index: RiverIndex;
  tolerance: number;
  /** Who holds the ground under a point: a realm index, or -1 for nobody. */
  ownerAt: (p: Position) => number;
}
import type { MultiPolygon, Polygon, Position } from 'geojson';

// Re-exported because it is part of this module's own signature: callers pass
// land in, and should not have to know which module defines its shape.
export type { LandPolygon };

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
   * How far a frontier may be from a river and still be put onto it, in cells.
   * 0 turns it off, which is the default — see `DEFAULT_GROWTH`.
   */
  riverSnap: number;
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
  // Just under a cell: wide enough to catch a frontier the lattice put one step
  // off the river, narrow enough to leave alone a border that merely passes
  // within sight of a tributary.
  //
  // On, now that a frontier is dressed once per border rather than once per
  // realm. It was off for two measured reasons and this is what each is worth,
  // over the whole map:
  //
  //   per realm, off                4 pairs overlapping,  2,211 km2
  //   per realm, on               114 pairs,             15,331 km2
  //   per realm, on + trespass guard 79 pairs,           18,785 km2
  //   per border, off               2 pairs,              1,594 km2
  //   per border, on               20 pairs,                795 km2
  //
  // Twenty-four times less torn ground than the best per-realm attempt, and
  // less than the map had with no snapping at all — the junctions being decided
  // once for everyone repairs disagreements that were there before rivers came
  // into it. What is left averages forty square kilometres a pair, which is
  // smaller than a lattice cell and of a piece with the junction rounding that
  // was always there.
  riverSnap: 0.8,
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

/** Scanlines sampled per cell row. Odd, so one of them is still the centre. */
const SUBSAMPLES = 3;

/**
 * Mark every lattice cell that holds any land at all.
 *
 * Scanline fill rather than a point-in-polygon test per cell: the land file is
 * one feature holding thousands of rings, and testing a quarter of a million
 * cells against all of them is minutes of work for an answer a single pass over
 * the edges gives in milliseconds.
 *
 * *Any* land, not land at the centre, and that distinction is the difference
 * between a realm that reaches the sea and one that stops short of it. A cell
 * is twenty kilometres across; Cape Cod, Nantucket, the Outer Banks and most of
 * Long Island are narrower than that, so a centre test cannot see them and no
 * realm could ever claim them — they stayed unclaimed ground on every map this
 * produced, with the frontier running inland of a coast it was supposed to
 * follow. Sampling several lines per row and marking every cell a span touches
 * puts the coastal fringe back on the lattice, where a realm can take it and
 * the trim can cut it back to the shore.
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
      const r0 = Math.max(0, Math.floor((lo - south) / cell));
      const r1 = Math.min(rows - 1, Math.floor((hi - south) / cell));
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
    for (let sub = 0; sub < SUBSAMPLES; sub++) {
      const y = south + (r + (sub + 0.5) / SUBSAMPLES) * cell;
      crossings.length = 0;
      for (const e of rowEdges[r]) {
        // Half-open comparison, so a vertex exactly on the scanline counts once.
        if (y1[e] <= y === y2[e] <= y) continue;
        crossings.push(x1[e] + ((y - y1[e]) * (x2[e] - x1[e])) / (y2[e] - y1[e]));
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        // Every cell the span touches, not every cell whose centre it covers:
        // a strip of land narrower than a cell still makes that cell land.
        const c0 = Math.max(0, Math.floor((crossings[i] - west) / cell));
        const c1 = Math.min(cols - 1, Math.floor((crossings[i + 1] - west) / cell));
        for (let c = c0; c <= c1; c++) {
          const k = r * cols + c;
          if (!land[k]) {
            land[k] = 1;
            landCount++;
          }
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


/** The four-connected neighbourhood the growth itself spreads through. */
const NEIGHBOURS: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * Hand every landlocked pocket of unclaimed ground to the realm around it.
 *
 * Growth stops each realm at its quota, so the ground nobody reached stays
 * wilderness — which is the point, and reads as the frontier zone it is when it
 * runs between realms or out to the sea. What does not read as anything is a
 * pocket left *inside* the settled country: a rounded hole in the middle of a
 * realm, with a hard sovereign border round it and nothing on the other side.
 * Nobody drawing this map by hand would leave one.
 *
 * So an unclaimed patch that touches neither open water nor the edge of the map
 * — a patch entirely ringed by realms — is given to whichever of them holds the
 * most of its perimeter. Wilderness that reaches the sea or runs off the map is
 * untouched: that is frontier, not a hole.
 *
 * Exported for its own test; the lattice is otherwise private to this module.
 */
export function fillEnclaves(
  cols: number,
  rows: number,
  land: Uint8Array,
  owner: Int32Array,
): { filled: number; cells: number } {
  const seen = new Uint8Array(cols * rows);
  const queue: number[] = [];
  const patch: number[] = [];
  let filled = 0;
  let cells = 0;

  for (let start = 0; start < owner.length; start++) {
    if (!land[start] || owner[start] !== -1 || seen[start]) continue;

    queue.length = 0;
    patch.length = 0;
    queue.push(start);
    seen[start] = 1;
    let open = false;
    const perimeter = new Map<number, number>();

    while (queue.length) {
      const cell = queue.pop()!;
      patch.push(cell);
      const r = (cell / cols) | 0;
      const c = cell - r * cols;
      for (const [dr, dc] of NEIGHBOURS) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) {
          open = true; // runs off the map
          continue;
        }
        const next = rr * cols + cc;
        if (!land[next]) {
          open = true; // reaches the sea
          continue;
        }
        if (owner[next] === -1) {
          if (!seen[next]) {
            seen[next] = 1;
            queue.push(next);
          }
          continue;
        }
        perimeter.set(owner[next], (perimeter.get(owner[next]) ?? 0) + 1);
      }
    }

    if (open || perimeter.size === 0) continue;
    // Most of the perimeter takes it; ties go to the lower realm index, so the
    // same inputs always give the same map.
    let best = -1;
    let bestCount = -1;
    for (const [realm, count] of perimeter) {
      if (count > bestCount || (count === bestCount && realm < best)) {
        best = realm;
        bestCount = count;
      }
    }
    for (const cell of patch) owner[cell] = best;
    filled++;
    cells += patch.length;
  }

  return { filled, cells };
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
    for (const [dr, dc] of NEIGHBOURS) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const next = rr * cols + cc;
      if (!grid.land[next] || owner[next] !== -1) continue;
      frontier.push(top.cost + reach * cost[next], next, realm);
    }
  }

  // Before anything is traced: no realm should be drawn with a hole in it that
  // belongs to nobody.
  fillEnclaves(cols, rows, grid.land, owner);
  for (let i = 0; i < taken.length; i++) taken[i] = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0) taken[owner[i]]++;

  const shapes = new Map<string, Polygon | MultiPolygon>();
  const claimed = new Map<string, number>();
  const coast = options.clipToCoast ? indexLand(land, options.extent) : null;
  // Rivers are indexed at the snapping tolerance, so a frontier vertex only
  // ever meets the handful of segments that could possibly be near it.
  const tolerance = Math.max(0, options.riverSnap) * options.cellSize;
  const riverBorders: RiverBorders | null =
    tolerance > 0 && riverLines.length
      ? {
          index: indexRivers(riverLines, tolerance),
          tolerance,
          ownerAt: ([x, y]) => {
            const c = Math.floor((x - grid.west) / grid.cell);
            const r = Math.floor((y - grid.south) / grid.cell);
            if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return -1;
            return owner[r * grid.cols + c];
          },
        }
      : null;
  // Decided once for the whole map, and one dressed arc per border, shared by
  // the realms either side of it.
  const junctions = findJunctions(grid, owner);
  const cache: ArcCache = { dressed: new Map() };

  seeds.forEach((seed, index) => {
    claimed.set(seed.id, taken[index]);
    const outline = traceRealm(grid, owner, index, options.smoothing, riverBorders, junctions, cache);
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
 * The corners where three or more regions meet.
 *
 * This is what makes a shared border genuinely shared. Each realm used to cut
 * its own ring wherever the neighbour on the other side changed as it walked —
 * a local rule, and two realms walking the same frontier do not always chop it
 * the same way. Where one of them cut a run in two and the other kept it whole,
 * they dressed different arcs and drifted apart, which is precisely how
 * snapping a frontier to a river tore the map.
 *
 * Deciding the junctions once, from the lattice, removes the disagreement at
 * source: both realms cut at the same corners, so both are handed the same arc.
 * Wilderness and the world's edge count as regions, because a frontier that
 * runs out into open ground ends there just as much as at a rival.
 */
function findJunctions(grid: Lattice, owner: Int32Array): Set<string> {
  const { cols, rows, cell, west, south } = grid;
  const ownerAt = (rr: number, cc: number) =>
    rr < 0 || cc < 0 || rr >= rows || cc >= cols ? -2 : owner[rr * cols + cc];
  const junctions = new Set<string>();
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const a = ownerAt(r - 1, c - 1);
      const b = ownerAt(r - 1, c);
      const d = ownerAt(r, c - 1);
      const e = ownerAt(r, c);
      const distinct = new Set([a, b, d, e]);
      if (distinct.size >= 3) junctions.add(cornerKey(west, south, cell, c, r));
    }
  }
  return junctions;
}

/** A lattice corner as a string, formatted identically wherever it is needed. */
function cornerKey(west: number, south: number, cell: number, c: number, r: number): string {
  return `${Number((west + c * cell).toFixed(6))},${Number((south + r * cell).toFixed(6))}`;
}

/**
 * One dressed arc, shared by the two realms either side of it.
 *
 * Keyed by the arc's own undressed vertices, canonicalised so that the same run
 * of border walked in either direction produces the same key — which is the
 * whole point: realm A holds it one way round and realm B the other, and they
 * must come away with the same line, not merely two lines that agree.
 */
interface ArcCache {
  dressed: Map<string, Position[]>;
}

function canonicalArcKey(arc: Position[]): { key: string; reversed: boolean } {
  const forward = arc.map((p) => `${p[0]},${p[1]}`).join(';');
  const backward = [...arc].reverse().map((p) => `${p[0]},${p[1]}`).join(';');
  return backward < forward ? { key: backward, reversed: true } : { key: forward, reversed: false };
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
  rivers: RiverBorders | null,
  junctions: Set<string>,
  cache: ArcCache,
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
      rings.push(dressRing(closed, neighbours, cell, smoothing, rivers, realm, junctions, cache));
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
 * So the ring is cut into arcs at the junctions where three or more regions
 * meet, and each arc is dressed once and *shared* by the realms either side of
 * it — looked up from a cache keyed on the arc's own undressed vertices, taken
 * in whichever direction sorts first so that both realms ask the same question.
 *
 * Both halves of that matter, and the second one was learned the hard way.
 * Cutting at globally-decided junctions rather than "wherever the neighbour
 * changes as I walk" is what guarantees the two realms are handed the *same*
 * arc; sharing one dressed result is what guarantees they get the same line out
 * of it rather than two lines that merely ought to agree. Simplifying and
 * rounding are symmetric under reversal, so the old arrangement survived them —
 * but snapping a frontier onto a river moves a line as far as the river, and it
 * did not survive that at all.
 */
function dressRing(
  ring: Position[],
  neighbours: number[],
  cell: number,
  smoothing: number,
  rivers: RiverBorders | null,
  realmIndex: number,
  junctions: Set<string>,
  cache: ArcCache,
): Position[] {
  const dress = (arc: Position[], neighbour: number): Position[] => {
    const { key, reversed } = canonicalArcKey(arc);
    const done = cache.dressed.get(key);
    if (done) return reversed ? [...done].reverse() : done;

    // Dress the arc the *canonical* way round, not the way this realm happens
    // to hold it, so the answer is one line rather than one line per realm.
    const canonical = reversed ? [...arc].reverse() : arc;
    const smoothed = smoothOpen(simplifyOpen(canonical, cell * 1.3), smoothing);
    let out = smoothed;
    if (rivers) {
      // The frontier may only be moved over ground the two realms either side
      // of it hold between them, or over nobody's. Anywhere else and both of
      // them walk onto a third realm that is not moving with them.
      const ours = (p: Position) => {
        const owner = rivers.ownerAt(p);
        return owner === -1 || owner === realmIndex || owner === neighbour;
      };
      out = snapToRivers(smoothed, rivers.index, rivers.tolerance, ours);
    }
    cache.dressed.set(key, out);
    return reversed ? [...out].reverse() : out;
  };
  if (neighbours.length !== ring.length - 1) {
    // A ring that did not close cleanly; treat it as one arc rather than guess.
    return dress(ring, neighbours[0] ?? -1);
  }

  // Cut points: the corners the whole map agreed on, not this realm's own idea
  // of where its neighbour changed.
  const cuts: number[] = [];
  for (let i = 0; i < neighbours.length; i++) {
    if (junctions.has(`${ring[i][0]},${ring[i][1]}`)) cuts.push(i);
  }

  // A ring with a single neighbour all the way round — an island, or a realm
  // entirely surrounded by wilderness — has no junctions to pin.
  // No junctions to pin — an island, or a realm entirely surrounded by
  // wilderness. Its whole outline is its own, so it is smoothed as one closed
  // loop; the first and last vertex are the same point, so pinning them keeps
  // it closed while the rest is free to find a river.
  if (cuts.length === 0) {
    const smoothed = smoothRing(simplifyRing(ring, cell * 1.3), smoothing);
    return rivers ? closeRing(dress(smoothed, neighbours[0] ?? -1)) : smoothed;
  }

  const out: Position[] = [];
  for (let k = 0; k < cuts.length; k++) {
    const from = cuts[k];
    const to = cuts[(k + 1) % cuts.length];
    const arc: Position[] = [];
    for (let i = from; ; i = (i + 1) % neighbours.length) {
      arc.push(ring[i]);
      if (i === to) break;
    }
    const dressed = dress(arc, neighbours[from]);
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

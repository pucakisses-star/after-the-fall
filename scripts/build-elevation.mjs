#!/usr/bin/env node
/**
 * Builds the bundled elevation dataset in `public/data/world/`.
 *
 * Everything else in `public/data/world/` is Natural Earth vector data that only
 * needs trimming. Elevation is not published as vectors by anyone, so this makes
 * them: it fetches a coarse public-domain digital elevation model, thresholds it
 * into hypsometric bands, and traces each band's outline into polygons.
 *
 *   node scripts/build-elevation.mjs
 *
 * Vectors rather than a relief raster, because everything downstream assumes
 * them: the SVG exporter draws the same geometry the screen does, style classes
 * colour it, and the crop clips it. A raster would need its own path through all
 * three and would still print worse at plate sizes.
 *
 * Each band is the region *at or above* its threshold, not a donut between two
 * thresholds, so the bands nest and are drawn lowest-first — the classic way an
 * atlas lays hypsometric tints down. Holes are still traced, because a basin
 * inside a plateau has to show the lower tint through it.
 *
 * Source: NOAA ETOPO 2022, via the CoastWatch ERDDAP server, which will subset
 * and decimate server-side — the full model is 478 MB of HDF5 and this needs
 * about forty of CSV. ETOPO is a US government work and in the public domain.
 */

import fs from 'node:fs';
import path from 'node:path';
import { topology } from 'topojson-server';

const ERDDAP = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.csv';
const OUT_DIR = path.resolve('public/data/world');
const OUT = 'elevation-americas.json';

/**
 * The window, and how coarsely it is sampled.
 *
 * The Americas, on the same reasoning as the roads and the province files: the
 * whole world at this resolution triples the size for ground this map is not
 * about. Stride 8 is 8 arc-minutes, about 15 km — far coarser than the
 * coastline, and deliberately so. These are background tints under a political
 * map, not a terrain model; finer sampling costs megabytes and shows as noise
 * along every band edge at the zooms anyone reads state names at.
 */
const WINDOW = { south: -60, north: 75, west: -170, east: -30 };
const STRIDE = 8;

/**
 * Where one tint stops and the next starts, in metres.
 *
 * The standard hypsometric ladder, compressed at the bottom because that is
 * where people live and where the interesting relief is: the Appalachians and
 * the Brazilian highlands separate at 200 and 500, and the Andes and Rockies
 * need the room above 2000.
 */
const BANDS = [200, 500, 1000, 2000, 3000, 4000];

/** Simplification tolerance in degrees. About a third of a cell. */
const TOLERANCE = 0.05;
/** Bands smaller than this are dropped as speckle, in square degrees. */
const MIN_AREA = 0.02;
/** Coordinate precision. 3 dp is ~110 m, finer than the 8-arc-minute grid. */
const PRECISION = 3;

async function fetchGrid() {
  const q =
    `?altitude%5B(${WINDOW.south}):${STRIDE}:(${WINDOW.north})%5D` +
    `%5B(${WINDOW.west}):${STRIDE}:(${WINDOW.east})%5D`;
  const res = await fetch(ERDDAP + q);
  if (!res.ok) throw new Error(`ERDDAP: HTTP ${res.status}`);
  const text = await res.text();

  // latitude,longitude,altitude — two header lines, then one row per sample,
  // latitude-major and ascending in both.
  const lines = text.split('\n');
  const lats = [];
  const lons = [];
  const seenLat = new Map();
  const seenLon = new Map();
  const values = [];

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const a = line.indexOf(',');
    const b = line.indexOf(',', a + 1);
    const lat = Number(line.slice(0, a));
    const lon = Number(line.slice(a + 1, b));
    const alt = Number(line.slice(b + 1));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!seenLat.has(lat)) { seenLat.set(lat, lats.length); lats.push(lat); }
    if (!seenLon.has(lon)) { seenLon.set(lon, lons.length); lons.push(lon); }
    values.push([seenLat.get(lat), seenLon.get(lon), Number.isFinite(alt) ? alt : 0]);
  }

  const rows = lats.length;
  const cols = lons.length;
  const grid = new Int16Array(rows * cols);
  for (const [r, c, v] of values) grid[r * cols + c] = Math.max(-32768, Math.min(32767, Math.round(v)));
  return { grid, rows, cols, lats, lons };
}

/**
 * Trace the outline of every cell at or above `threshold`.
 *
 * Walks the boundary between inside and outside cells as directed segments with
 * the inside kept on the left, then chains them into closed rings. Winding falls
 * out of that convention: an outer ring comes back counter-clockwise and a hole
 * clockwise, which is also what GeoJSON asks for, so nothing has to be reversed
 * afterwards.
 */
function traceBand(grid, rows, cols, lats, lons, threshold) {
  const inside = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r * cols + c] >= threshold;

  // Cell (r,c) spans lons[c]..lons[c+1] and lats[r]..lats[r+1]; the last row and
  // column have no far edge, so the grid is treated as one cell smaller.
  const x = (c) => lons[Math.min(c, lons.length - 1)];
  const y = (r) => lats[Math.min(r, lats.length - 1)];
  const key = (r, c) => `${r},${c}`;

  /** start-corner -> end-corner, one entry per boundary segment. */
  const next = new Map();
  const push = (r0, c0, r1, c1) => {
    const k = key(r0, c0);
    const list = next.get(k);
    if (list) list.push([r1, c1]);
    else next.set(k, [[r1, c1]]);
  };

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (!inside(r, c)) continue;
      // Corners of this cell in (row, col) index space.
      if (!inside(r + 1, c)) push(r + 1, c + 1, r + 1, c); // north edge, heading west
      if (!inside(r - 1, c)) push(r, c, r, c + 1); // south edge, heading east
      if (!inside(r, c + 1)) push(r, c + 1, r + 1, c + 1); // east edge, heading north
      if (!inside(r, c - 1)) push(r + 1, c, r, c); // west edge, heading south
    }
  }

  const rings = [];
  for (const [start, ends] of next) {
    while (ends.length) {
      const ring = [];
      let [r, c] = start.split(',').map(Number);
      let step = ends.pop();
      const first = `${r},${c}`;
      ring.push([r, c]);
      while (step) {
        const [nr, nc] = step;
        ring.push([nr, nc]);
        if (`${nr},${nc}` === first) break;
        const outs = next.get(`${nr},${nc}`);
        if (!outs || !outs.length) break;
        step = outs.pop();
      }
      if (ring.length > 3) rings.push(ring.map(([rr, cc]) => [x(cc), y(rr)]));
    }
  }

  return rings
    .map((ring) => simplify(closeRing(ring), TOLERANCE))
    .filter((ring) => ring.length > 3 && Math.abs(signedArea(ring)) >= MIN_AREA);
}

function closeRing(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 1; i < ring.length; i++) {
    a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  }
  return a / 2;
}

/** Iterative Ramer–Douglas–Peucker, endpoints pinned. */
function simplify(points, tolerance) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let far = -1;
    let best = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointLineDistance(points[i], points[lo], points[hi]);
      if (d > best) {
        best = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function pointLineDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Put each clockwise ring inside the counter-clockwise ring that contains it. */
function assemble(rings) {
  const outers = rings.filter((r) => signedArea(r) > 0);
  const holes = rings.filter((r) => signedArea(r) < 0);
  const polys = outers.map((o) => [o]);

  for (const hole of holes) {
    const probe = hole[0];
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      if (!inRing(outers[i], probe)) continue;
      const a = Math.abs(signedArea(outers[i]));
      if (a < bestArea) {
        bestArea = a;
        best = i;
      }
    }
    // A hole with no container is a tracing artefact; dropping it is safer than
    // promoting it to land that is not there.
    if (best >= 0) polys[best].push(hole);
  }
  return polys;
}

function inRing(ring, [px, py]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const round = (n) => Number(n.toFixed(PRECISION));

async function main() {
  console.log('Fetching ETOPO 2022 via ERDDAP…');
  const t0 = Date.now();
  const { grid, rows, cols, lats, lons } = await fetchGrid();
  console.log(`  ${cols} × ${rows} samples in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const features = [];
  for (const threshold of BANDS) {
    const rings = traceBand(grid, rows, cols, lats, lons, threshold);
    const polys = assemble(rings);
    if (!polys.length) continue;
    features.push({
      type: 'Feature',
      properties: { band: threshold, name: `${threshold} m` },
      geometry: {
        type: 'MultiPolygon',
        coordinates: polys.map((p) => p.map((ring) => ring.map(([x, y]) => [round(x), round(y)]))),
      },
    });
    const verts = polys.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);
    console.log(`  ${String(threshold).padStart(5)} m  ${String(polys.length).padStart(4)} parts  ${verts} vertices`);
  }

  const topo = topology({ elevation: { type: 'FeatureCollection', features } }, 1e5);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, OUT);
  fs.writeFileSync(target, JSON.stringify(topo));
  console.log(`\n${OUT}  ${(fs.statSync(target).size / 1024).toFixed(0)} KB`);
  console.log('Commit public/data/world/ to keep clones offline-capable.');
}

await main();

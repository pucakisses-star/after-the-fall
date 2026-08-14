/**
 * Real-world reference geography (spec §3).
 *
 * Ships with Natural Earth land and country outlines and the US Census state and
 * county boundaries, as TopoJSON under /data. TopoJSON rather than GeoJSON because
 * it is roughly a fifth of the size and, crucially, stores shared boundaries as
 * shared arcs — so counties converted from it start out already topologically
 * clean, which is exactly what the shared-border system wants.
 */

import { feature as topoFeature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from 'geojson';
import { intersection } from './operations';
import type { BasemapSource } from '@/model/types';

/**
 * Bundled reference geography, all at Natural Earth's finest published scale.
 *
 * The coarser 1:110m and 1:50m editions used to ship alongside these. They are
 * gone: a coastline that is visibly wrong the moment you zoom in is not worth
 * the megabyte it saves, and offering three versions of the same layer made
 * every choice in the panel a question about file size rather than about the
 * map. One scale, the good one. Beyond it you want a national dataset (the US
 * files below) or your own import.
 */
export const BUILTIN_BASEMAPS: BasemapSource[] = [
  {
    id: 'world-land-10m',
    name: 'World coastlines',
    url: 'data/world/land-10m.json',
    format: 'topojson',
    objectName: 'land',
    role: 'land',
  },
  {
    id: 'world-countries-10m',
    name: 'Country boundaries',
    url: 'data/world/countries-10m.json',
    format: 'topojson',
    objectName: 'countries',
    role: 'countries',
  },
  {
    id: 'world-lakes-10m',
    name: 'Lakes',
    url: 'data/world/lakes-10m.json',
    format: 'topojson',
    objectName: 'lakes',
    role: 'lakes',
  },
  {
    id: 'world-rivers-10m',
    name: 'Rivers',
    url: 'data/world/rivers-10m.json',
    format: 'topojson',
    objectName: 'rivers',
    role: 'rivers',
  },
  {
    id: 'world-places-10m',
    name: 'Cities & towns',
    url: 'data/world/places-10m.json',
    format: 'topojson',
    objectName: 'places',
    role: 'places',
  },
  {
    id: 'na-admin1-10m',
    name: 'Provinces & states (N. America)',
    url: 'data/world/admin1-na-10m.json',
    format: 'topojson',
    objectName: 'admin1',
    role: 'states',
  },
  {
    id: 'us-states',
    name: 'US states (Census)',
    url: 'data/us/states-10m.json',
    format: 'topojson',
    objectName: 'states',
    role: 'states',
  },
  {
    id: 'us-counties',
    name: 'US counties (Census)',
    url: 'data/us/counties-10m.json',
    format: 'topojson',
    objectName: 'counties',
    role: 'counties',
  },
];

/**
 * Approximate download size, shown next to each dataset so the detailed files
 * are an informed choice rather than a surprise. Values are the on-disk sizes of
 * the shipped TopoJSON.
 */
export const BASEMAP_SIZES: Record<string, string> = {
  'world-land-10m': '2.9 MB',
  'world-countries-10m': '3.5 MB',
  'world-lakes-10m': '1.2 MB',
  'world-rivers-10m': '2.0 MB',
  'world-places-10m': '1.4 MB',
  'na-admin1-10m': '1.4 MB',
  'us-states': '110 KB',
  'us-counties': '820 KB',
};

export type PolyFeature = Feature<Polygon | MultiPolygon, Record<string, unknown>>;
export type LineFeature = Feature<LineString | MultiLineString, Record<string, unknown>>;
export type PointFeature = Feature<Point | MultiPoint, Record<string, unknown>>;
/**
 * Anything a reference dataset can hold: lakes and coastlines are polygons,
 * rivers are lines, populated places are points.
 */
export type BasemapFeature = PolyFeature | LineFeature | PointFeature;

const cache = new Map<string, BasemapFeature[]>();
const inflight = new Map<string, Promise<BasemapFeature[]>>();

export function findBasemapSource(id: string): BasemapSource | undefined {
  return BUILTIN_BASEMAPS.find((b) => b.id === id) ?? userSources.get(id);
}

/** Sources added at runtime by importing a file (spec §47). */
const userSources = new Map<string, BasemapSource>();

export function registerUserSource(source: BasemapSource, features: BasemapFeature[]): void {
  userSources.set(source.id, source);
  cache.set(source.id, features);
}

export function allBasemapSources(): BasemapSource[] {
  return [...BUILTIN_BASEMAPS, ...userSources.values()];
}

/** Load (and memoise) a basemap dataset as WGS84 GeoJSON features. */
export async function loadBasemap(id: string): Promise<BasemapFeature[]> {
  const hit = cache.get(id);
  if (hit) return hit;
  const pending = inflight.get(id);
  if (pending) return pending;

  const source = findBasemapSource(id);
  if (!source) throw new Error(`Unknown basemap source "${id}"`);

  const promise = (async () => {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`Could not load ${source.name} (${res.status})`);
    const json = await res.json();

    let features: BasemapFeature[];
    if (source.format === 'topojson') {
      const topo = json as Topology;
      const objectName = source.objectName ?? Object.keys(topo.objects)[0];
      const obj = topo.objects[objectName];
      if (!obj) throw new Error(`TopoJSON object "${objectName}" not found in ${source.name}`);
      const collection = topoFeature(topo, obj as GeometryCollection) as unknown as FeatureCollection;
      features = collection.features.filter(isDrawableFeature);
    } else {
      const collection = json as FeatureCollection;
      features = (collection.features ?? []).filter(isDrawableFeature);
    }

    cache.set(id, features);
    inflight.delete(id);
    return features;
  })();

  inflight.set(id, promise);
  return promise;
}

export function isPolygonFeature(f: Feature): f is PolyFeature {
  return !!f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
}

export function isLineFeature(f: Feature): f is LineFeature {
  return !!f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString');
}

export function isPointFeature(f: Feature): f is PointFeature {
  return !!f.geometry && (f.geometry.type === 'Point' || f.geometry.type === 'MultiPoint');
}

function isDrawableFeature(f: Feature): f is BasemapFeature {
  return isPolygonFeature(f) || isLineFeature(f) || isPointFeature(f);
}

/**
 * A part with this many vertices is cut at the bounding box instead of clipped
 * geometrically. Eurasia is around 60,000 points in the 1:10m file, and putting
 * that through a polygon-clipping pass on every load costs more than the tidier
 * edge is worth. Cutting it whole is the behaviour that shipped before clipping
 * existed, so the fallback is never worse than what it replaced.
 */
const CLIP_VERTEX_LIMIT = 40_000;

interface PartInfo {
  box: [number, number, number, number];
  vertices: number;
  /** True when a ring steps across the antimeridian, making `box` meaningless. */
  wraps: boolean;
  /** Whether any vertex falls inside the window — the fallback test when it does. */
  anyInside: boolean;
}

/**
 * Measure a part against a window in one pass: bounding box, size, whether it
 * crosses the antimeridian, and whether any of it is actually inside.
 *
 * The wrap matters. Afro-Eurasia is one part of Natural Earth's 1:10m land file
 * with a ring that steps from +180° to −180°, so its plain bounding box is the
 * entire globe and every window on Earth "intersects" it. That is how the whole
 * of Eurasia turns up in a map of the Americas.
 */
function describePart(coords: unknown, valid: [number, number, number, number]): PartInfo {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  let vertices = 0;
  let wraps = false;
  let anyInside = false;
  const walkRing = (ring: unknown[]): void => {
    let prev: number | null = null;
    for (const c of ring) {
      if (!Array.isArray(c) || typeof c[0] !== 'number') {
        walk(c);
        continue;
      }
      const [x, y] = c as number[];
      vertices++;
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
      if (prev !== null && Math.abs(x - prev) > 180) wraps = true;
      prev = x;
      if (!anyInside && x >= valid[0] && x <= valid[2] && y >= valid[1] && y <= valid[3]) {
        anyInside = true;
      }
    }
  };
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (Array.isArray(c[0]) && typeof (c[0] as unknown[])[0] === 'number') {
      walkRing(c);
      return;
    }
    for (const v of c) walk(v);
  };
  if (Array.isArray(coords) && typeof (coords as unknown[])[0] === 'number') {
    walkRing([coords]);
  } else {
    walk(coords);
  }
  return { box: [w, s, e, n], vertices, wraps, anyInside };
}

/**
 * Restrict a reference feature to a geographic window — the projection's domain
 * of validity, narrowed by the map's working extent.
 *
 * This has to work at *part* level, not feature level: Natural Earth's land file
 * is a single Feature holding a MultiPolygon of four thousand landmasses, so
 * testing the feature's own bounding box tells you only that the world is in the
 * world. Antarctica is one part of that MultiPolygon, and in a North-America
 * conic it projects to a ring 66,000 km across that fills the canvas with land
 * colour — which is why the ocean disappears unless the part is removed first.
 *
 * Parts fully inside are passed through untouched, parts fully outside are
 * dropped, and a polygon straddling the edge is genuinely cut to it. That last
 * case matters once a map has a working extent: Russia's bounding box reaches
 * −180° because of Chukotka, so a bounding-box test alone admits the whole of
 * Eurasia into a map of the Americas — visible the moment you zoom out far
 * enough to see past the crop.
 *
 * Returns `null` when nothing survives.
 */
export function clipToValidArea(
  f: BasemapFeature,
  valid: [number, number, number, number],
): BasemapFeature | null {
  /**
   * A part reaches the window if its box overlaps — unless the part wraps the
   * antimeridian, in which case its box spans the globe and says nothing, and
   * the only trustworthy answer is whether any of its vertices are in there.
   */
  const reaches = (p: PartInfo) =>
    p.wraps
      ? p.anyInside
      : !(p.box[2] < valid[0] || p.box[0] > valid[2] || p.box[3] < valid[1] || p.box[1] > valid[3]);
  const contained = (box: [number, number, number, number]) =>
    box[0] >= valid[0] && box[1] >= valid[1] && box[2] <= valid[2] && box[3] <= valid[3];

  const g = f.geometry;

  // Points and lines are kept or dropped whole. A point is exact either way, and
  // cutting a river at the frame gains nothing a viewport clip does not already
  // do — the cost of the wrong answer is a few strokes of ink, not a continent
  // of fill.
  if (g.type === 'Point' || g.type === 'LineString') {
    return reaches(describePart(g.coordinates, valid)) ? f : null;
  }
  if (g.type === 'MultiPoint' || g.type === 'MultiLineString') {
    const parts = (g.coordinates as unknown[]).filter((part) => reaches(describePart(part, valid)));
    if (parts.length === 0) return null;
    if (parts.length === (g.coordinates as unknown[]).length) return f;
    return { ...f, geometry: { ...g, coordinates: parts } } as BasemapFeature;
  }

  const window: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [valid[0], valid[1]],
        [valid[2], valid[1]],
        [valid[2], valid[3]],
        [valid[0], valid[3]],
        [valid[0], valid[1]],
      ],
    ],
  };

  const source = g.type === 'Polygon' ? [g.coordinates] : (g.coordinates as Position[][][]);
  const kept: Position[][][] = [];
  let changed = false;

  for (const part of source) {
    const info = describePart(part, valid);
    if (!reaches(info)) {
      changed = true;
      continue;
    }
    // A wrapping part is never cut: the clipper works in the plane, so a ring
    // that steps across the antimeridian would come back as a band smeared
    // across the whole window.
    if (contained(info.box) || info.wraps || info.vertices > CLIP_VERTEX_LIMIT) {
      kept.push(part);
      continue;
    }
    let cut: ReturnType<typeof intersection> = null;
    try {
      cut = intersection({ type: 'Polygon', coordinates: part }, window);
    } catch {
      cut = null;
    }
    if (!cut) {
      // The clip failed or came back empty. Empty is the common case — a part
      // whose box overlaps the window but whose land does not — so drop it.
      changed = true;
      continue;
    }
    changed = true;
    if (cut.type === 'Polygon') kept.push(cut.coordinates);
    else for (const p of cut.coordinates) kept.push(p);
  }

  if (kept.length === 0) return null;
  if (!changed) return f;
  return {
    ...f,
    geometry:
      kept.length === 1
        ? { type: 'Polygon', coordinates: kept[0] }
        : { type: 'MultiPolygon', coordinates: kept },
  } as BasemapFeature;
}

/** Polygon-only view of a dataset, for the operations that need areas. */
export function polygonsOf(features: BasemapFeature[]): PolyFeature[] {
  return features.filter(isPolygonFeature);
}

export function linesOf(features: BasemapFeature[]): LineFeature[] {
  return features.filter(isLineFeature);
}

export function pointsOf(features: BasemapFeature[]): PointFeature[] {
  return features.filter(isPointFeature);
}

/**
 * Best-effort display name for a basemap feature. Every dataset labels its rows
 * differently; check the usual suspects in order.
 */
export function basemapFeatureName(f: BasemapFeature): string {
  const p = (f.properties ?? {}) as Record<string, unknown>;
  for (const key of ['name', 'NAME', 'NAME_EN', 'admin', 'ADMIN', 'title', 'Name']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (typeof f.id === 'string' || typeof f.id === 'number') return String(f.id);
  return 'Unnamed';
}

/** US county FIPS codes start with the two-digit state code. */
export function basemapFeatureStateFips(f: BasemapFeature): string | null {
  const id = f.id;
  if (typeof id === 'string' && /^\d{4,5}$/.test(id)) return id.padStart(5, '0').slice(0, 2);
  if (typeof id === 'number') return String(id).padStart(5, '0').slice(0, 2);
  return null;
}

/** Two-digit FIPS → state name, for filtering counties by state on import. */
export const STATE_FIPS: Record<string, string> = {
  '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas', '06': 'California',
  '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware', '11': 'District of Columbia',
  '12': 'Florida', '13': 'Georgia', '15': 'Hawaii', '16': 'Idaho', '17': 'Illinois',
  '18': 'Indiana', '19': 'Iowa', '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana',
  '23': 'Maine', '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota',
  '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska', '32': 'Nevada',
  '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico', '36': 'New York',
  '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio', '40': 'Oklahoma', '41': 'Oregon',
  '42': 'Pennsylvania', '44': 'Rhode Island', '45': 'South Carolina', '46': 'South Dakota',
  '47': 'Tennessee', '48': 'Texas', '49': 'Utah', '50': 'Vermont', '51': 'Virginia',
  '53': 'Washington', '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming',
  '60': 'American Samoa', '66': 'Guam', '69': 'Northern Mariana Islands',
  '72': 'Puerto Rico', '78': 'US Virgin Islands',
};

export function stateNameToFips(name: string): string | null {
  const target = name.trim().toLowerCase();
  for (const [fips, n] of Object.entries(STATE_FIPS)) {
    if (n.toLowerCase() === target) return fips;
  }
  return null;
}

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
} from 'geojson';
import type { BasemapSource } from '@/model/types';

/**
 * Bundled reference geography, ordered coarse → detailed within each family.
 *
 * The scale is part of the name because it is the thing that actually matters
 * when choosing: 1:110m is a world-at-a-glance outline, 1:50m holds up to about
 * country level, and 1:10m is the finest Natural Earth publishes — roughly seven
 * times the vertex density of 1:50m in a region-sized view. Beyond that you want
 * a national dataset (the US files below) or your own import.
 */
export const BUILTIN_BASEMAPS: BasemapSource[] = [
  {
    id: 'world-land-110m',
    name: 'World coastlines — 1:110m (coarse)',
    url: 'data/world/land-110m.json',
    format: 'topojson',
    objectName: 'land',
    role: 'land',
  },
  {
    id: 'world-land-50m',
    name: 'World coastlines — 1:50m (medium)',
    url: 'data/world/land-50m.json',
    format: 'topojson',
    objectName: 'land',
    role: 'land',
  },
  {
    id: 'world-land-10m',
    name: 'World coastlines — 1:10m (detailed)',
    url: 'data/world/land-10m.json',
    format: 'topojson',
    objectName: 'land',
    role: 'land',
  },
  {
    id: 'world-countries-110m',
    name: 'Country boundaries — 1:110m (coarse)',
    url: 'data/world/countries-110m.json',
    format: 'topojson',
    objectName: 'countries',
    role: 'countries',
  },
  {
    id: 'world-countries-50m',
    name: 'Country boundaries — 1:50m (medium)',
    url: 'data/world/countries-50m.json',
    format: 'topojson',
    objectName: 'countries',
    role: 'countries',
  },
  {
    id: 'world-countries-10m',
    name: 'Country boundaries — 1:10m (detailed)',
    url: 'data/world/countries-10m.json',
    format: 'topojson',
    objectName: 'countries',
    role: 'countries',
  },
  {
    id: 'world-lakes-110m',
    name: 'Lakes — 1:110m (coarse)',
    url: 'data/world/lakes-110m.json',
    format: 'topojson',
    objectName: 'lakes',
    role: 'lakes',
  },
  {
    id: 'world-lakes-50m',
    name: 'Lakes — 1:50m (medium)',
    url: 'data/world/lakes-50m.json',
    format: 'topojson',
    objectName: 'lakes',
    role: 'lakes',
  },
  {
    id: 'world-lakes-10m',
    name: 'Lakes — 1:10m (detailed)',
    url: 'data/world/lakes-10m.json',
    format: 'topojson',
    objectName: 'lakes',
    role: 'lakes',
  },
  {
    id: 'world-rivers-110m',
    name: 'Rivers — 1:110m (coarse)',
    url: 'data/world/rivers-110m.json',
    format: 'topojson',
    objectName: 'rivers',
    role: 'rivers',
  },
  {
    id: 'world-rivers-50m',
    name: 'Rivers — 1:50m (medium)',
    url: 'data/world/rivers-50m.json',
    format: 'topojson',
    objectName: 'rivers',
    role: 'rivers',
  },
  {
    id: 'world-rivers-10m',
    name: 'Rivers — 1:10m (detailed)',
    url: 'data/world/rivers-10m.json',
    format: 'topojson',
    objectName: 'rivers',
    role: 'rivers',
  },
  {
    id: 'world-places-110m',
    name: 'Cities & towns — 1:110m (major only)',
    url: 'data/world/places-110m.json',
    format: 'topojson',
    objectName: 'places',
    role: 'places',
  },
  {
    id: 'world-places-50m',
    name: 'Cities & towns — 1:50m (medium)',
    url: 'data/world/places-50m.json',
    format: 'topojson',
    objectName: 'places',
    role: 'places',
  },
  {
    id: 'world-places-10m',
    name: 'Cities & towns — 1:10m (detailed)',
    url: 'data/world/places-10m.json',
    format: 'topojson',
    objectName: 'places',
    role: 'places',
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
  'world-land-110m': '55 KB',
  'world-land-50m': '530 KB',
  'world-land-10m': '2.9 MB',
  'world-countries-110m': '105 KB',
  'world-countries-50m': '740 KB',
  'world-countries-10m': '3.5 MB',
  'world-lakes-110m': '7 KB',
  'world-lakes-50m': '200 KB',
  'world-lakes-10m': '1.2 MB',
  'world-rivers-110m': '11 KB',
  'world-rivers-50m': '285 KB',
  'world-rivers-10m': '2.0 MB',
  'world-places-110m': '47 KB',
  'world-places-50m': '235 KB',
  'world-places-10m': '1.4 MB',
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
 * Drop the parts of a feature that fall outside a projection's domain of validity.
 *
 * This has to work at *part* level, not feature level: Natural Earth's land file
 * is a single Feature holding a MultiPolygon of four thousand landmasses, so
 * testing the feature's own bounding box tells you only that the world is in the
 * world. Antarctica is one part of that MultiPolygon, and in a North-America
 * conic it projects to a ring 66,000 km across that fills the canvas with land
 * colour — which is why the ocean disappears unless the part is removed first.
 *
 * Returns `null` when nothing survives.
 */
export function clipToValidArea(
  f: BasemapFeature,
  valid: [number, number, number, number],
): BasemapFeature | null {
  const intersects = (box: [number, number, number, number]) =>
    !(box[2] < valid[0] || box[0] > valid[2] || box[3] < valid[1] || box[1] > valid[3]);

  const bboxOf = (coords: unknown): [number, number, number, number] => {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    const walk = (c: unknown): void => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === 'number') {
        const [x, y] = c as number[];
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
        return;
      }
      for (const v of c) walk(v);
    };
    walk(coords);
    return [w, s, e, n];
  };

  const g = f.geometry;

  // Single-part geometry: keep or drop whole.
  if (g.type === 'Polygon' || g.type === 'LineString' || g.type === 'Point') {
    return intersects(bboxOf(g.coordinates)) ? f : null;
  }

  const kept = (g.coordinates as unknown[]).filter((part) => intersects(bboxOf(part)));
  if (kept.length === 0) return null;
  if (kept.length === (g.coordinates as unknown[]).length) return f; // untouched

  return {
    ...f,
    geometry: { ...g, coordinates: kept },
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

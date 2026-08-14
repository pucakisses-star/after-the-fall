/**
 * Import (spec §47) and conversion of reference geography into editable
 * territories (spec §3, §55).
 */

import KML from 'ol/format/KML';
import GPX from 'ol/format/GPX';
import GeoJSONFormat from 'ol/format/GeoJSON';
import { feature as topoFeature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type {
  Feature as GjFeature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Point,
  Polygon,
} from 'geojson';

import { newId } from '@/model/ids';
import { STYLE_IDS } from '@/model/defaults';
import { dissolve, interiorPoint } from '@/geo/operations';
import { boundsOf, clipToLand, indexLand, landPolygonsOf, type LandIndex } from '@/geo/coastline';
import {
  basemapFeatureName,
  findBasemapSource,
  linesOf,
  loadBasemap,
  pointsOf,
  polygonsOf,
  registerUserSource,
  type BasemapFeature,
} from '@/geo/basemap';
import { roadClass, routeShield } from '@/render/olStyles';
import { commit, getProject, makeLabel, makeLinear, makeSettlement, makeTerritory } from '@/state/projectStore';
import { territoryAt } from '@/state/commands';
import { useUIStore, toast } from '@/state/uiStore';
import type { BorderStyleKind, PoliticalType, Settlement, Territory, UUID } from '@/model/types';

const olGeoJson = new GeoJSONFormat();

export type ImportKind = 'geojson' | 'topojson' | 'kml' | 'gpx' | 'csv' | 'unknown';

export function detectKind(filename: string, text: string): ImportKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.kml')) return 'kml';
  if (lower.endsWith('.gpx')) return 'gpx';
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv';
  if (lower.endsWith('.topojson')) return 'topojson';
  if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.type === 'Topology') return 'topojson';
      return 'geojson';
    } catch {
      return 'unknown';
    }
  }
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith('<')) return head.includes('<gpx') ? 'gpx' : 'kml';
  if (head.startsWith('{')) {
    try {
      return JSON.parse(text)?.type === 'Topology' ? 'topojson' : 'geojson';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

/** Parse any supported vector format into a plain GeoJSON FeatureCollection. */
export function parseVectorFile(filename: string, text: string): FeatureCollection {
  const kind = detectKind(filename, text);
  switch (kind) {
    case 'geojson': {
      const parsed = JSON.parse(text);
      if (parsed.type === 'FeatureCollection') return parsed as FeatureCollection;
      if (parsed.type === 'Feature') return { type: 'FeatureCollection', features: [parsed] };
      // A bare geometry is legal GeoJSON too.
      return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: parsed }] };
    }
    case 'topojson': {
      const topo = JSON.parse(text) as Topology;
      const out: GjFeature[] = [];
      for (const key of Object.keys(topo.objects)) {
        const collection = topoFeature(topo, topo.objects[key] as GeometryCollection) as unknown as FeatureCollection;
        out.push(...collection.features);
      }
      return { type: 'FeatureCollection', features: out };
    }
    case 'kml':
    case 'gpx': {
      const format = kind === 'kml' ? new KML({ extractStyles: false }) : new GPX();
      const features = format.readFeatures(text, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:4326',
      });
      const json = olGeoJson.writeFeaturesObject(features, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:4326',
      });
      return json as FeatureCollection;
    }
    default:
      throw new Error(`Unrecognised file "${filename}". Supported: GeoJSON, TopoJSON, KML, GPX, CSV.`);
  }
}

// ---------------------------------------------------------------------------
// Importing into the document
// ---------------------------------------------------------------------------

export interface ImportSummary {
  territories: number;
  settlements: number;
  lines: number;
  skipped: number;
}

export interface ImportOptions {
  /** Property to read names from; auto-detected when omitted. */
  nameField?: string;
  politicalType?: PoliticalType;
  borderKind?: BorderStyleKind;
  /** Create labels alongside imported features. */
  createLabels?: boolean;
  parentId?: UUID | null;
}

const NAME_KEYS = ['name', 'NAME', 'Name', 'NAME_EN', 'admin', 'ADMIN', 'title', 'label', 'NAMELSAD'];

function nameOf(props: Record<string, unknown> | null, field?: string): string | null {
  if (!props) return null;
  if (field && typeof props[field] === 'string') return props[field] as string;
  for (const key of NAME_KEYS) {
    const v = props[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Bring a parsed FeatureCollection into the project as editable features. */
export function importFeatureCollection(fc: FeatureCollection, opts: ImportOptions = {}): ImportSummary {
  const project = getProject();
  const summary: ImportSummary = { territories: 0, settlements: 0, lines: 0, skipped: 0 };
  const createLabels = opts.createLabels ?? true;

  commit('Import features', (r) => {
    for (const f of fc.features) {
      const g = f.geometry;
      if (!g) {
        summary.skipped++;
        continue;
      }
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const name = nameOf(props, opts.nameField) ?? `Imported ${summary.territories + summary.settlements + summary.lines + 1}`;

      if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
        const t = makeTerritory(project, g as Polygon | MultiPolygon, {
          name,
          politicalType: opts.politicalType ?? 'province',
          borderKind: opts.borderKind ?? 'provincial',
          parentId: opts.parentId ?? null,
          notes: describeProps(props),
        });
        if (createLabels) {
          const label = makeLabel(project, { type: 'Point', coordinates: interiorPoint(t.geometry) }, {
            kind: 'region',
            text: name,
            attachedToId: t.id,
          });
          r.set('territories', { ...t, labelId: label.id });
          r.set('labels', label);
        } else {
          r.set('territories', t);
        }
        summary.territories++;
      } else if (g.type === 'Point') {
        const s = makeSettlement(project, g as Point, {
          name,
          population: numberFrom(props, ['population', 'POP', 'pop', 'POPULATION']),
          notes: describeProps(props),
        });
        if (createLabels) {
          const label = makeLabel(project, g as Point, {
            kind: 'city',
            text: name,
            attachedToId: s.id,
            offset: [8, 0],
          });
          r.set('settlements', { ...s, labelId: label.id });
          r.set('labels', label);
        } else {
          r.set('settlements', s);
        }
        summary.settlements++;
      } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
        const lf = makeLinear(project, g as LineString | MultiLineString, {
          name,
          kind: guessLinearKind(props),
          notes: describeProps(props),
        });
        r.set('linearFeatures', lf);
        summary.lines++;
      } else if (g.type === 'MultiPoint') {
        for (const c of g.coordinates) {
          const s = makeSettlement(project, { type: 'Point', coordinates: c }, { name });
          r.set('settlements', s);
          summary.settlements++;
        }
      } else {
        summary.skipped++;
      }
    }
  });

  return summary;
}

function describeProps(props: Record<string, unknown>): string {
  const entries = Object.entries(props).filter(
    ([k, v]) => v !== null && v !== '' && !NAME_KEYS.includes(k) && typeof v !== 'object',
  );
  if (!entries.length) return '';
  return entries.slice(0, 12).map(([k, v]) => `${k}: ${String(v)}`).join('\n');
}

function numberFrom(props: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = props[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function guessLinearKind(props: Record<string, unknown>): string {
  const blob = JSON.stringify(props).toLowerCase();
  if (blob.includes('river') || blob.includes('stream') || blob.includes('creek')) return 'river';
  if (blob.includes('canal')) return 'canal';
  if (blob.includes('road') || blob.includes('highway') || blob.includes('route')) return 'road-major';
  if (blob.includes('trail') || blob.includes('path')) return 'trail';
  return 'river';
}

// ---------------------------------------------------------------------------
// CSV settlements (spec §47)
// ---------------------------------------------------------------------------

export interface CsvColumnMap {
  name: number;
  lat: number;
  lon: number;
  type?: number;
  population?: number;
}

/** Minimal RFC-4180 reader: handles quoted fields, embedded commas and newlines. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const d = delimiter ?? (text.includes('\t') && !text.includes(',') ? '\t' : ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === d) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Guess which columns hold the fields §47 asks us to recognise. */
export function guessCsvColumns(header: string[]): CsvColumnMap | null {
  const find = (...candidates: string[]) =>
    header.findIndex((h) => candidates.includes(h.trim().toLowerCase()));

  const name = find('name', 'city', 'settlement', 'place', 'title', 'label');
  const lat = find('lat', 'latitude', 'y');
  const lon = find('lon', 'lng', 'long', 'longitude', 'x');
  if (lat < 0 || lon < 0) return null;

  const map: CsvColumnMap = { name: name >= 0 ? name : 0, lat, lon };
  const type = find('type', 'category', 'kind', 'class');
  if (type >= 0) map.type = type;
  const population = find('population', 'pop', 'inhabitants');
  if (population >= 0) map.population = population;
  return map;
}

export function importCsvSettlements(rows: string[][], columns: CsvColumnMap, hasHeader = true): number {
  const project = getProject();
  const body = hasHeader ? rows.slice(1) : rows;
  let count = 0;

  commit('Import settlements', (r) => {
    for (const row of body) {
      const lat = Number(row[columns.lat]);
      const lon = Number(row[columns.lon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const name = (row[columns.name] ?? '').trim() || 'Settlement';
      const rawType = columns.type !== undefined ? (row[columns.type] ?? '').trim().toLowerCase() : '';
      const type = normaliseSettlementType(rawType);
      const popRaw = columns.population !== undefined ? Number(row[columns.population]) : NaN;

      const s = makeSettlement(project, { type: 'Point', coordinates: [lon, lat] }, {
        name,
        type,
        population: Number.isFinite(popRaw) ? popRaw : null,
      });
      const label = makeLabel(project, { type: 'Point', coordinates: [lon, lat] }, {
        kind: 'city',
        text: name,
        attachedToId: s.id,
        offset: [8, 0],
      });
      r.set('settlements', { ...s, labelId: label.id });
      r.set('labels', label);
      count++;
    }
  });
  return count;
}

function normaliseSettlementType(raw: string): Settlement['type'] {
  const t = raw.replace(/[\s_]+/g, '-');
  const known = [
    'imperial-capital', 'national-capital', 'regional-capital',
    'city', 'town', 'village', 'fortress', 'port', 'monastery', 'ruins',
  ];
  if (known.includes(t)) return t;
  if (t.includes('capital')) return 'national-capital';
  if (t.includes('fort') || t.includes('castle')) return 'fortress';
  if (t.includes('port') || t.includes('harbo')) return 'port';
  if (t.includes('abbey') || t.includes('monast')) return 'monastery';
  if (t.includes('ruin')) return 'ruins';
  if (t.includes('town')) return 'town';
  if (t.includes('village') || t.includes('hamlet')) return 'village';
  return 'city';
}

// ---------------------------------------------------------------------------
// Reference geography → editable territories (spec §3)
// ---------------------------------------------------------------------------

export interface ConvertOptions {
  sourceId: string;
  /** Restrict to features whose name is in this set. Empty = everything. */
  includeNames?: Set<string>;
  /**
   * Restrict by position in the dataset. Preferred over `includeNames` for
   * datasets with duplicate names — Natural Earth's lakes include hundreds of
   * unnamed ones and several genuine "Trout Lake"s, so a name is not an id.
   */
  includeIndices?: Set<number>;
  /** Restrict US counties to these two-digit state FIPS codes. */
  includeStateFips?: Set<string>;
  politicalType?: PoliticalType;
  borderKind?: BorderStyleKind;
  parentId?: UUID | null;
  createLabels?: boolean;
  /**
   * Trim each converted shape to the coastline.
   *
   * Administrative boundaries are drawn to their own tolerance, not the
   * coastline's: the Census cartographic file describes the whole of
   * Massachusetts, Cape Cod included, in 155 vertices, and covers 420 km² of
   * open sea doing it. Under a shoreline with a thousand times the detail that
   * reads as a fill cutting across every bay, with the real coast outside it.
   */
  snapToCoast?: boolean;
}

/**
 * The dataset a conversion trims against — the finest coastline the app ships.
 *
 * Deliberately not "whatever land layer happens to be switched on": the trim
 * should give the same answer whatever the user is looking at.
 */
const COASTLINE_SOURCE = 'world-land-10m';

/** The land the conversion trims against, indexed around what is being converted. */
async function coastlineFor(shapes: (Polygon | MultiPolygon)[]): Promise<LandIndex | null> {
  try {
    const land = landPolygonsOf(
      polygonsOf(await loadBasemap(COASTLINE_SOURCE)).map((f) => f.geometry as Polygon | MultiPolygon),
    );
    return indexLand(land, boundsOf(shapes));
  } catch {
    // No coastline available: convert at the source's own resolution rather
    // than refuse, and say so at the call site.
    return null;
  }
}

/**
 * Turn reference geography into real, editable territories.
 *
 * This is the answer to §3's "the user should not be forced to trace the entire
 * coastline of North America manually": pick a dataset, filter it, and every
 * selected feature becomes a `Territory` with full geometry and its own record.
 */
export async function convertBasemapToTerritories(opts: ConvertOptions): Promise<number> {
  const all = await loadBasemap(opts.sourceId);
  const role = findBasemapSource(opts.sourceId)?.role;

  // Rivers are lines and places are points; send them down their own paths
  // instead of silently producing nothing.
  if (role === 'rivers') return convertBasemapToRivers(opts);
  if (role === 'roads') return convertBasemapToRoads(opts);
  if (role === 'places') return convertBasemapToSettlements(opts);

  const features = polygonsOf(all);
  const filtered = features.filter((f, i) => {
    if (opts.includeIndices?.size && !opts.includeIndices.has(i)) return false;
    if (opts.includeNames?.size && !opts.includeNames.has(basemapFeatureName(f))) return false;
    if (opts.includeStateFips?.size) {
      const id = typeof f.id === 'number' ? String(f.id) : String(f.id ?? '');
      const fips = id.padStart(5, '0').slice(0, 2);
      if (!opts.includeStateFips.has(fips)) return false;
    }
    return true;
  });

  if (filtered.length === 0) return 0;

  const project = getProject();
  const createLabels = opts.createLabels ?? true;
  const isWater = role === 'lakes';

  // A lake is water by definition, so trimming it to the land would delete it.
  const shapes = filtered.map((f) => f.geometry as Polygon | MultiPolygon);
  const coast = opts.snapToCoast && !isWater ? await coastlineFor(shapes) : null;
  const geometryOf = (g: Polygon | MultiPolygon) => (coast ? clipToLand(g, coast) : null) ?? g;

  commit('Import reference geography', (r) => {
    for (const f of filtered) {
      const name = basemapFeatureName(f);
      const t = makeTerritory(project, geometryOf(f.geometry as Polygon | MultiPolygon), {
        name,
        // A lake is a water body, not a polity — give it the water style class
        // and a quiet shoreline rather than a political border weight.
        politicalType: isWater ? 'lake' : (opts.politicalType ?? 'province'),
        borderKind: isWater ? 'historical' : (opts.borderKind ?? 'provincial'),
        styleClassId: isWater ? STYLE_IDS.territoryWater : undefined,
        parentId: isWater ? null : (opts.parentId ?? null),
      });
      if (createLabels && name && name !== 'Unnamed') {
        const label = makeLabel(project, { type: 'Point', coordinates: interiorPoint(t.geometry) }, {
          kind: isWater ? 'water' : 'region',
          text: name,
          attachedToId: t.id,
        });
        r.set('territories', { ...t, labelId: label.id });
        r.set('labels', label);
      } else {
        r.set('territories', t);
      }
    }
  });

  return filtered.length;
}

/**
 * Turn a river dataset into editable `LinearFeature`s (spec §3, §16: "it should
 * be easy to import existing river datasets").
 *
 * Natural Earth splits long rivers into several named segments, so each one
 * arrives as its own feature; merging them is left to the user because which
 * segments count as "the same river" is an editorial decision.
 */
export async function convertBasemapToRivers(opts: ConvertOptions): Promise<number> {
  const all = await loadBasemap(opts.sourceId);
  const rivers = linesOf(all).filter((f, i) => {
    if (opts.includeIndices?.size && !opts.includeIndices.has(i)) return false;
    if (opts.includeNames?.size && !opts.includeNames.has(basemapFeatureName(f))) return false;
    return true;
  });
  if (rivers.length === 0) return 0;

  const project = getProject();
  const createLabels = opts.createLabels ?? true;

  commit('Import rivers', (r) => {
    for (const f of rivers) {
      const name = basemapFeatureName(f);
      // Natural Earth's scalerank doubles as a rough importance ranking, so the
      // major rivers come in heavier than the minor ones.
      const rank = Number((f.properties as Record<string, unknown>)?.scalerank ?? 8);
      const lf = makeLinear(project, f.geometry as LineString | MultiLineString, {
        name,
        kind: rank <= 5 ? 'river-major' : 'river',
      });
      if (createLabels && name && name !== 'Unnamed') {
        const label = makeLabel(project, { type: 'Point', coordinates: midpointOf(f) }, {
          kind: 'river',
          text: name,
          attachedToId: lf.id,
          pathId: lf.id, // run the name along the river itself (§12, §16)
        });
        r.set('linearFeatures', { ...lf, labelId: label.id });
        r.set('labels', label);
      } else {
        r.set('linearFeatures', lf);
      }
    }
  });

  return rivers.length;
}

/**
 * Turn a road dataset into editable `LinearFeature`s (spec §3, §16).
 *
 * Deliberately not the river path with a different colour. A converted highway
 * has to arrive as a *road*: the kinds and style classes for one already exist,
 * and sending it down the river path would produce a blue watercourse named
 * "95" that flows into things. The name is the route shield the renderer draws —
 * I-95, not the bare number Natural Earth stores — so the imported feature is
 * called what the map called it.
 *
 * No labels unless they are asked for, and no text-on-path at all — both of
 * which the rivers do. Natural Earth splits I-95 into 71 segments that all carry
 * the same number, so labelling each one the way a river is labelled puts 71
 * copies of "I-95" down the eastern seaboard; and a route number is a marker
 * repeated along a road rather than a name written down its length, so setting
 * it as a path label would stretch "I-95" across five hundred miles. The name
 * still comes across on the feature, where the inspector, the data table and
 * search can all find it.
 */
export async function convertBasemapToRoads(opts: ConvertOptions): Promise<number> {
  const all = await loadBasemap(opts.sourceId);
  const roads = linesOf(all).filter((f, i) => {
    if (opts.includeIndices?.size && !opts.includeIndices.has(i)) return false;
    if (opts.includeNames?.size && !opts.includeNames.has(basemapFeatureName(f))) return false;
    return true;
  });
  if (roads.length === 0) return 0;

  const project = getProject();
  const createLabels = opts.createLabels ?? false;

  commit('Import roads', (r) => {
    for (const f of roads) {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const name = routeShield(props);
      const lf = makeLinear(project, f.geometry as LineString | MultiLineString, {
        name: name || 'Unnamed',
        // The same three-way split the renderer draws, collapsed onto the two
        // road kinds the document has.
        kind: roadClass(props) === 'minor' ? 'road-minor' : 'road-major',
      });
      if (createLabels && name) {
        const label = makeLabel(project, { type: 'Point', coordinates: midpointOf(f) }, {
          kind: 'region',
          text: name,
          attachedToId: lf.id,
        });
        r.set('linearFeatures', { ...lf, labelId: label.id });
        r.set('labels', label);
      } else {
        r.set('linearFeatures', lf);
      }
    }
  });

  return roads.length;
}

/**
 * Turn a populated-places dataset into editable `Settlement`s (spec §14).
 *
 * Natural Earth's `featurecla` already carries the distinction a historical
 * atlas cares about — national capital, regional capital, ordinary town — so it
 * maps straight onto the settlement types and each city arrives with the right
 * symbol rather than as an undifferentiated dot. Population comes from
 * `pop_max`, and the country and region become the note, so the provenance of an
 * imported city is still visible after you have renamed it.
 */
export async function convertBasemapToSettlements(opts: ConvertOptions): Promise<number> {
  const all = await loadBasemap(opts.sourceId);
  const places = pointsOf(all).filter((f, i) => {
    if (opts.includeIndices?.size && !opts.includeIndices.has(i)) return false;
    if (opts.includeNames?.size && !opts.includeNames.has(basemapFeatureName(f))) return false;
    return true;
  });
  if (places.length === 0) return 0;

  const project = getProject();
  const createLabels = opts.createLabels ?? true;

  commit('Import settlements', (r) => {
    for (const f of places) {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const name = basemapFeatureName(f);
      const population = Number(props.pop_max);
      const type = settlementTypeFromNaturalEarth(
        typeof props.featurecla === 'string' ? props.featurecla : '',
        Number.isFinite(population) ? population : null,
      );
      const coords = f.geometry.type === 'Point'
        ? (f.geometry.coordinates as [number, number])
        : (f.geometry.coordinates[0] as [number, number]);

      const where = [props.adm1name, props.adm0name].filter(Boolean).join(', ');
      const s = makeSettlement(project, { type: 'Point', coordinates: coords }, {
        name,
        type,
        population: Number.isFinite(population) ? population : null,
        ownerId: territoryAt(project, coords)?.id ?? null,
        notes: where ? String(where) : '',
      });

      if (createLabels) {
        const label = makeLabel(project, { type: 'Point', coordinates: coords }, {
          kind: 'city',
          text: name,
          attachedToId: s.id,
          styleClassId: type.includes('capital') ? STYLE_IDS.textCapital : STYLE_IDS.textCity,
          offset: [type.includes('capital') ? 11 : 8, 0],
        });
        r.set('settlements', { ...s, labelId: label.id });
        r.set('labels', label);
      } else {
        r.set('settlements', s);
      }
    }
  });

  return places.length;
}

/** Natural Earth's `featurecla`, plus population as a tie-breaker for towns. */
export function settlementTypeFromNaturalEarth(featurecla: string, population: number | null): Settlement['type'] {
  const c = featurecla.toLowerCase();
  if (c.startsWith('admin-0 capital')) return 'national-capital';
  if (c.startsWith('admin-1') || c.includes('region capital')) return 'regional-capital';
  if (c.includes('historic')) return 'ruins';
  if (population === null) return 'city';
  if (population >= 250_000) return 'city';
  if (population >= 25_000) return 'town';
  return 'village';
}

/** A point roughly halfway along a line, used to anchor its label. */
function midpointOf(f: BasemapFeature): [number, number] {
  const g = f.geometry;
  const line =
    g.type === 'LineString' ? g.coordinates
    : g.type === 'MultiLineString' ? g.coordinates[Math.floor(g.coordinates.length / 2)]
    : null;
  if (!line || line.length === 0) return [0, 0];
  const c = line[Math.floor(line.length / 2)];
  return [c[0], c[1]];
}

/**
 * Build one dissolved territory from a set of reference features — the fast path
 * behind the demo map and behind "select several counties → make a kingdom" (§55).
 */
export async function territoryFromBasemapFeatures(
  sourceId: string,
  names: string[],
  init: Partial<Territory>,
  keepSubdivisions = true,
  snapToCoast = false,
): Promise<UUID | null> {
  const features = polygonsOf(await loadBasemap(sourceId));
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const matched = features.filter((f) => wanted.has(basemapFeatureName(f).toLowerCase()));
  if (matched.length === 0) return null;

  // Trim before dissolving, not after: the members share their inland borders
  // exactly, and trimming each to the same coastline leaves those borders
  // untouched, so the dissolve still finds them and erases them cleanly.
  const shapes = matched.map((f) => f.geometry as Polygon | MultiPolygon);
  const coast = snapToCoast ? await coastlineFor(shapes) : null;
  const geometryOf = (g: Polygon | MultiPolygon) => (coast ? clipToLand(g, coast) : null) ?? g;

  const merged = dissolve(shapes.map(geometryOf));
  if (!merged) return null;

  const project = getProject();
  const parent = makeTerritory(project, merged, { ...init, id: init.id ?? newId() });
  const parentLabel = makeLabel(project, { type: 'Point', coordinates: interiorPoint(merged) }, {
    kind: 'country',
    text: parent.name,
    attachedToId: parent.id,
  });

  commit(`Create ${parent.name}`, (r) => {
    r.set('territories', { ...parent, labelId: parentLabel.id });
    r.set('labels', parentLabel);
    if (keepSubdivisions) {
      for (const f of matched) {
        const child = makeTerritory(project, geometryOf(f.geometry as Polygon | MultiPolygon), {
          name: basemapFeatureName(f),
          politicalType: 'province',
          parentId: parent.id,
          borderKind: 'provincial',
          inheritParentColor: true,
        });
        r.set('territories', child);
      }
    }
  });

  return parent.id;
}

// ---------------------------------------------------------------------------
// User-supplied basemap files (spec §3, §47)
// ---------------------------------------------------------------------------

export function registerImportedBasemap(filename: string, text: string): string {
  const fc = parseVectorFile(filename, text);
  const usable = fc.features.filter((f): f is BasemapFeature => {
    const t = f.geometry?.type;
    return t === 'Polygon' || t === 'MultiPolygon' || t === 'LineString' || t === 'MultiLineString';
  });
  if (usable.length === 0) {
    throw new Error('That file contains no polygons or lines to use as reference geography.');
  }
  // Lines-only files are almost always rivers or roads; treat them as such so
  // they render as strokes rather than as empty fills.
  const allLines = usable.every((f) => f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString');
  const id = `user-${newId()}`;
  registerUserSource(
    {
      id,
      name: filename.replace(/\.[^.]+$/, ''),
      url: '',
      format: 'geojson',
      role: allLines ? 'rivers' : 'custom',
    },
    usable,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Reference image (spec §32)
// ---------------------------------------------------------------------------

export interface ReferenceImageState {
  url: string;
  /** WGS84 [minLon, minLat, maxLon, maxLat]. */
  extent: [number, number, number, number];
  opacity: number;
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * Place an image over the current view, keeping its aspect ratio, ready to be
 * traced. Nudging and rescaling happen through the Reference Image panel.
 */
export function referenceImageForView(
  file: File,
  viewExtent: [number, number, number, number],
): Promise<ReferenceImageState> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const [w, s, e, n] = viewExtent;
      const viewW = e - w;
      const viewH = n - s;
      const imgAspect = img.naturalWidth / img.naturalHeight;
      // Fit inside the view, centred.
      let width = viewW * 0.8;
      let height = width / imgAspect;
      if (height > viewH * 0.8) {
        height = viewH * 0.8;
        width = height * imgAspect;
      }
      const cx = (w + e) / 2;
      const cy = (s + n) / 2;
      resolve({
        url,
        extent: [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2],
        opacity: 0.6,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That image could not be read.'));
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Convenience wrapper used by the Import dialog
// ---------------------------------------------------------------------------

export async function importFile(file: File, opts: ImportOptions = {}): Promise<ImportSummary> {
  const text = await file.text();
  const kind = detectKind(file.name, text);

  if (kind === 'csv') {
    const rows = parseCsv(text);
    if (rows.length === 0) throw new Error('That CSV is empty.');
    const columns = guessCsvColumns(rows[0]);
    if (!columns) {
      throw new Error('Could not find latitude and longitude columns. Expected headers like "Name, Latitude, Longitude, Type, Population".');
    }
    const count = importCsvSettlements(rows, columns, true);
    return { territories: 0, settlements: count, lines: 0, skipped: rows.length - 1 - count };
  }

  const fc = parseVectorFile(file.name, text);
  const summary = importFeatureCollection(fc, opts);
  const total = summary.territories + summary.settlements + summary.lines;
  if (total === 0) throw new Error('No usable features found in that file.');
  return summary;
}

/** Export the document's geography as GeoJSON (spec §48). */
export function projectToGeoJson(): FeatureCollection {
  const project = getProject();
  const features: GjFeature[] = [];

  for (const t of Object.values(project.territories)) {
    features.push({
      type: 'Feature',
      id: t.id,
      geometry: t.geometry,
      properties: {
        kind: 'territory',
        name: t.name,
        shortName: t.shortName,
        politicalType: t.politicalType,
        parentId: t.parentId,
        capitalId: t.capitalId,
        borderKind: t.borderKind,
        startYear: t.timeline.start,
        endYear: t.timeline.end,
        notes: t.notes,
      },
    });
  }
  for (const s of Object.values(project.settlements)) {
    features.push({
      type: 'Feature',
      id: s.id,
      geometry: s.geometry,
      properties: {
        kind: 'settlement',
        name: s.name,
        type: s.type,
        population: s.population,
        ownerId: s.ownerId,
        startYear: s.timeline.start,
        endYear: s.timeline.end,
      },
    });
  }
  for (const f of Object.values(project.linearFeatures)) {
    if (f.kind === 'label-path') continue;
    features.push({
      type: 'Feature',
      id: f.id,
      geometry: f.geometry,
      properties: { kind: 'linear', name: f.name, linearKind: f.kind },
    });
  }
  for (const l of Object.values(project.labels)) {
    features.push({
      type: 'Feature',
      id: l.id,
      geometry: l.anchor,
      properties: { kind: 'label', text: l.text, labelKind: l.kind, rotation: l.rotation },
    });
  }

  return { type: 'FeatureCollection', features };
}

/** Wired to the Import dialog's file input; reports its own errors. */
export async function importFileWithFeedback(file: File, opts: ImportOptions = {}): Promise<void> {
  try {
    useUIStore.getState().setStatus(`Importing ${file.name}…`);
    const summary = await importFile(file, opts);
    const bits: string[] = [];
    if (summary.territories) bits.push(`${summary.territories} territories`);
    if (summary.settlements) bits.push(`${summary.settlements} settlements`);
    if (summary.lines) bits.push(`${summary.lines} lines`);
    toast(`Imported ${bits.join(', ')}.`, 'success');
  } catch (err) {
    toast((err as Error).message, 'error');
  } finally {
    useUIStore.getState().setStatus(null);
  }
}

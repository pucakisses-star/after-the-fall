/**
 * Project construction, layer scaffolding and schema migration (spec §49).
 */

import { newId } from './ids';
import { createDefaultStyleSheet } from './defaults';
import { defaultProjection, findPreset } from '@/geo/projections';
import type { LayerKind, MapLayer, MapProject, ProjectionSettings, StyleSheet, UUID } from './types';

export const SCHEMA_VERSION = 1;

/**
 * The default layer stack, bottom to top. Mirrors the structure in spec §19 and,
 * not by accident, the SVG group order required by §66 — one ordering drives both
 * the screen and the export.
 */
const DEFAULT_LAYER_STACK: { name: string; kind: LayerKind; children?: { name: string; kind: LayerKind }[] }[] = [
  { name: 'Reference Image', kind: 'reference-image' },
  { name: 'Ocean', kind: 'ocean' },
  { name: 'Coastline', kind: 'basemap' },
  { name: 'Territories', kind: 'territory' },
  { name: 'Political Borders', kind: 'border' },
  { name: 'Rivers', kind: 'river' },
  { name: 'Roads', kind: 'road' },
  { name: 'Settlements', kind: 'settlement' },
  {
    name: 'Labels',
    kind: 'group',
    children: [
      { name: 'Water Labels', kind: 'label' },
      { name: 'City Labels', kind: 'label' },
      { name: 'Region Labels', kind: 'label' },
      { name: 'Country Labels', kind: 'label' },
    ],
  },
  { name: 'Graticule', kind: 'graticule' },
];

export interface DefaultLayerIds {
  ocean: UUID;
  coastline: UUID;
  territories: UUID;
  borders: UUID;
  rivers: UUID;
  roads: UUID;
  settlements: UUID;
  labelsGroup: UUID;
  waterLabels: UUID;
  cityLabels: UUID;
  regionLabels: UUID;
  countryLabels: UUID;
  graticule: UUID;
  referenceImage: UUID;
}

export function createDefaultLayers(): { layers: Record<UUID, MapLayer>; ids: DefaultLayerIds } {
  const layers: Record<UUID, MapLayer> = {};
  const byName: Record<string, UUID> = {};
  let order = 0;

  for (const spec of DEFAULT_LAYER_STACK) {
    const id = newId();
    byName[spec.name] = id;
    layers[id] = {
      id,
      name: spec.name,
      kind: spec.kind,
      parentId: null,
      visible: true,
      locked: false,
      opacity: 1,
      collapsed: false,
      order: order++,
    };
    if (spec.children) {
      let childOrder = 0;
      for (const child of spec.children) {
        const cid = newId();
        byName[child.name] = cid;
        layers[cid] = {
          id: cid,
          name: child.name,
          kind: child.kind,
          parentId: id,
          visible: true,
          locked: false,
          opacity: 1,
          collapsed: false,
          order: childOrder++,
        };
      }
    }
  }

  return {
    layers,
    ids: {
      referenceImage: byName['Reference Image'],
      ocean: byName['Ocean'],
      coastline: byName['Coastline'],
      territories: byName['Territories'],
      borders: byName['Political Borders'],
      rivers: byName['Rivers'],
      roads: byName['Roads'],
      settlements: byName['Settlements'],
      labelsGroup: byName['Labels'],
      waterLabels: byName['Water Labels'],
      cityLabels: byName['City Labels'],
      regionLabels: byName['Region Labels'],
      countryLabels: byName['Country Labels'],
      graticule: byName['Graticule'],
    },
  };
}

export interface NewProjectOptions {
  title?: string;
  projectionId?: string;
  center?: [number, number];
  zoom?: number;
  /** WGS84 [w, s, e, n] the map is about; null or omitted means the whole world. */
  workingExtent?: [number, number, number, number] | null;
}

export function createProject(opts: NewProjectOptions = {}): MapProject {
  const { layers } = createDefaultLayers();
  const now = new Date().toISOString();
  // `projectionId` was accepted and then quietly ignored, so every caller that
  // asked for one silently got the default instead.
  const preset = opts.projectionId ? findPreset(opts.projectionId) : undefined;
  const projection: ProjectionSettings = preset
    ? { id: preset.id, name: preset.name, proj4: preset.proj4, extent: preset.extent, units: preset.units }
    : defaultProjection();

  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    meta: {
      title: opts.title ?? 'Untitled Map',
      subtitle: '',
      author: '',
      dateLine: '',
      notes: '',
      createdAt: now,
      modifiedAt: now,
    },
    projection,
    view: {
      center: opts.center ?? [-74, 42],
      zoom: opts.zoom ?? 5,
      rotation: 0,
    },
    workingExtent: opts.workingExtent ?? null,
    layers,
    territories: {},
    settlements: {},
    linearFeatures: {},
    labels: {},
    styles: createDefaultStyleSheet(),
    timeline: { enabled: false, currentYear: 1453, minYear: 800, maxYear: 1900, step: 1 },
    basemap: [
      { sourceId: 'world-land-10m', visible: true, opacity: 1 },
      { sourceId: 'world-lakes-10m', visible: true, opacity: 1 },
      { sourceId: 'world-countries-10m', visible: false, opacity: 1 },
      { sourceId: 'world-rivers-10m', visible: false, opacity: 1 },
      { sourceId: 'world-roads-10m', visible: false, opacity: 1 },
      { sourceId: 'world-places-10m', visible: true, opacity: 1 },
      { sourceId: 'na-admin1-10m', visible: false, opacity: 1 },
      { sourceId: 'us-states', visible: false, opacity: 1 },
      { sourceId: 'us-counties', visible: false, opacity: 1 },
    ],
    oceanColor: '#cfe0ea',
    landColor: '#f0e8d5',
    // Both off by default and both derived when switched on, so a new map never
    // carries an empty box or a key to things it does not contain (§26, §28).
    legend: { enabled: false, title: 'Legend', position: 'bottom-left', auto: true, entries: [] },
    compass: { enabled: false, style: 'star', position: 'top-right', size: 46 },
  };
}

/**
 * Point a project saved against the old 1:110m and 1:50m editions at the single
 * scale that remains, rather than leaving it referring to files that no longer
 * exist — which would surface as an error toast and a missing layer.
 */
function migrateBasemap(basemap: MapProject['basemap']): MapProject['basemap'] {
  const seen = new Set<string>();
  const out: MapProject['basemap'] = [];
  for (const entry of basemap) {
    const sourceId = entry.sourceId.replace(/-(110|50)m$/, '-10m');
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    out.push({ ...entry, sourceId });
  }
  return out;
}

/** Resolve the default layer for a given kind, creating nothing. */
export function findLayerByKind(project: MapProject, kind: LayerKind): MapLayer | undefined {
  const candidates = Object.values(project.layers).filter((l) => l.kind === kind);
  candidates.sort((a, b) => a.order - b.order);
  return candidates[0];
}

/**
 * Upgrade a project loaded from disk. Every migration is additive so old files
 * keep working (spec §63.15).
 */
export function migrate(raw: unknown): MapProject {
  const p = raw as MapProject & Record<string, unknown>;
  if (!p || typeof p !== 'object') throw new Error('Not a project file');

  const version = typeof p.schemaVersion === 'number' ? p.schemaVersion : 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `This project was made with a newer version of the app (schema ${version}, this build reads ${SCHEMA_VERSION}).`,
    );
  }

  // Fill in anything a v0 (pre-release) file may lack, and re-seed built-in styles
  // so a project made before a style was added still resolves it.
  const builtin = createDefaultStyleSheet();
  const incoming = p.styles ?? builtin;
  const styles: StyleSheet = {
    territory: { ...builtin.territory, ...(incoming.territory ?? {}) },
    line: { ...builtin.line, ...(incoming.line ?? {}) },
    text: { ...builtin.text, ...(incoming.text ?? {}) },
    symbol: { ...builtin.symbol, ...(incoming.symbol ?? {}) },
  };

  return {
    ...createProject(),
    ...p,
    schemaVersion: SCHEMA_VERSION,
    styles,
    territories: p.territories ?? {},
    settlements: p.settlements ?? {},
    linearFeatures: p.linearFeatures ?? {},
    labels: p.labels ?? {},
    basemap: migrateBasemap(p.basemap ?? []),
    legend: p.legend ?? createProject().legend,
    compass: p.compass ?? createProject().compass,
  };
}

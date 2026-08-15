/**
 * Demonstration map (spec §65).
 *
 * Builds a fictional political map of the north-eastern United States from the
 * real US Census state boundaries, so that borders, hierarchy, labels, symbols
 * and styling can all be judged at a glance.
 *
 * Nothing about the application is hard-coded around these states — this module
 * is pure test data, driven by the same public APIs the UI uses.
 */

import { basemapFeatureName, loadBasemap, polygonsOf } from '@/geo/basemap';
import { boundsOf, clipToLand, indexLand, landPolygonsOf, type LandIndex } from '@/geo/coastline';
import { dissolve, interiorPoint } from '@/geo/operations';
import { PALETTES, STYLE_IDS, defaultFixedSize } from '@/model/defaults';
import { createProject } from '@/model/project';
import { findLayerByKind } from '@/model/project';
import { newId } from '@/model/ids';
import type { MapLabel, MapProject, PoliticalType, Settlement, Territory } from '@/model/types';
import type { MultiPolygon, Polygon } from 'geojson';

interface StateDef {
  name: string;
  type: PoliticalType;
  members: string[];
  color: string;
  capital: { name: string; lon: number; lat: number };
  cities: { name: string; lon: number; lat: number; type: Settlement['type'] }[];
}

const REALMS: StateDef[] = [
  {
    name: 'Kingdom of New England',
    type: 'kingdom',
    members: ['Massachusetts', 'Rhode Island', 'Connecticut', 'New Hampshire', 'Vermont', 'Maine'],
    color: PALETTES['historical-atlas'][0],
    capital: { name: 'Boston', lon: -71.0589, lat: 42.3601 },
    cities: [
      { name: 'Portsmouth', lon: -70.7626, lat: 43.0718, type: 'port' },
      { name: 'Providence', lon: -71.4128, lat: 41.824, type: 'regional-capital' },
      { name: 'Hartford', lon: -72.6851, lat: 41.7637, type: 'regional-capital' },
      { name: 'Portland', lon: -70.2553, lat: 43.6591, type: 'port' },
      { name: 'Burlington', lon: -73.2121, lat: 44.4759, type: 'town' },
      { name: 'Worcester', lon: -71.8023, lat: 42.2626, type: 'city' },
      { name: 'Fort Ticonderoga', lon: -73.3879, lat: 43.8412, type: 'fortress' },
    ],
  },
  {
    name: 'Duchy of New York',
    type: 'grand-duchy',
    members: ['New York'],
    color: PALETTES['historical-atlas'][3],
    capital: { name: 'New Amsterdam', lon: -74.006, lat: 40.7128 },
    cities: [
      { name: 'Albany', lon: -73.7562, lat: 42.6526, type: 'regional-capital' },
      { name: 'Buffalo', lon: -78.8784, lat: 42.8864, type: 'city' },
      { name: 'Syracuse', lon: -76.1474, lat: 43.0481, type: 'city' },
      { name: 'Kingston', lon: -73.9971, lat: 41.9271, type: 'town' },
      { name: 'Sackets Harbor', lon: -76.1188, lat: 43.9459, type: 'fortress' },
    ],
  },
  {
    name: 'Republic of New Jersey',
    type: 'republic',
    members: ['New Jersey'],
    color: PALETTES['historical-atlas'][2],
    capital: { name: 'Trenton', lon: -74.7429, lat: 40.2206 },
    cities: [
      { name: 'Newark', lon: -74.1724, lat: 40.7357, type: 'city' },
      { name: 'Cape May', lon: -74.9057, lat: 38.9351, type: 'port' },
      { name: 'Princeton', lon: -74.6672, lat: 40.3573, type: 'monastery' },
    ],
  },
  {
    name: 'Commonwealth of Pennsylvania',
    type: 'confederation',
    members: ['Pennsylvania'],
    color: PALETTES['historical-atlas'][1],
    capital: { name: 'Philadelphia', lon: -75.1652, lat: 39.9526 },
    cities: [
      { name: 'Harrisburg', lon: -76.8867, lat: 40.2732, type: 'regional-capital' },
      { name: 'Pittsburgh', lon: -79.9959, lat: 40.4406, type: 'city' },
      { name: 'Lancaster', lon: -76.3055, lat: 40.0379, type: 'town' },
      { name: 'Erie', lon: -80.0851, lat: 42.1292, type: 'port' },
      { name: 'Bethlehem', lon: -75.3705, lat: 40.6259, type: 'monastery' },
    ],
  },
  {
    name: 'Marches of Delaware and Maryland',
    type: 'march',
    members: ['Delaware', 'Maryland'],
    color: PALETTES['historical-atlas'][4],
    capital: { name: 'Annapolis', lon: -76.4922, lat: 38.9784 },
    cities: [
      { name: 'Baltimore', lon: -76.6122, lat: 39.2904, type: 'port' },
      { name: 'Wilmington', lon: -75.5398, lat: 39.7459, type: 'city' },
      { name: 'Cumberland', lon: -78.7625, lat: 39.6529, type: 'fortress' },
    ],
  },
];

/** Purely decorative water and region labels, to exercise the label engine. */
const WATER_LABELS: { text: string; lon: number; lat: number; kind: MapLabel['kind'] }[] = [
  { text: 'Atlantic Ocean', lon: -70.2, lat: 39.2, kind: 'ocean' },
  { text: 'Gulf of Maine', lon: -68.6, lat: 43.2, kind: 'water' },
  { text: 'Long Island Sound', lon: -72.6, lat: 41.08, kind: 'water' },
  { text: 'Chesapeake Bay', lon: -76.2, lat: 38.2, kind: 'water' },
  { text: 'Lake Ontario', lon: -77.3, lat: 43.65, kind: 'water' },
  { text: 'Lake Erie', lon: -80.2, lat: 42.35, kind: 'water' },
];

const REGION_LABELS: { text: string; lon: number; lat: number }[] = [
  { text: 'The Berkshires', lon: -73.2, lat: 42.45 },
  { text: 'Adirondack Wilds', lon: -74.3, lat: 44.1 },
  { text: 'Allegheny Highlands', lon: -78.4, lat: 41.5 },
  { text: 'Pine Barrens', lon: -74.5, lat: 39.75 },
];

const RIVERS: { name: string; coords: [number, number][] }[] = [
  {
    name: 'Hudson',
    coords: [
      [-73.62, 44.02], [-73.78, 43.3], [-73.79, 42.75], [-73.75, 42.28],
      [-73.93, 41.72], [-73.95, 41.2], [-74.02, 40.71],
    ],
  },
  {
    name: 'Connecticut',
    coords: [
      [-71.55, 45.0], [-72.15, 44.2], [-72.44, 43.4], [-72.6, 42.6],
      [-72.6, 41.95], [-72.4, 41.5], [-72.34, 41.27],
    ],
  },
  {
    name: 'Delaware',
    coords: [
      [-74.85, 42.05], [-75.05, 41.6], [-75.07, 41.0], [-74.87, 40.5],
      [-75.14, 39.95], [-75.4, 39.5], [-75.35, 39.05],
    ],
  },
  {
    name: 'Susquehanna',
    coords: [
      [-75.9, 42.45], [-76.15, 41.95], [-76.65, 41.42], [-76.9, 40.8],
      [-76.6, 40.25], [-76.15, 39.85], [-76.08, 39.5],
    ],
  },
];

export interface DemoBuildResult {
  project: MapProject;
  center: [number, number];
  zoom: number;
}

/**
 * Build the demo project from scratch. Async because it fetches the real state
 * boundaries; falls back to an empty project if that fetch fails.
 */
export async function buildDemoProject(): Promise<DemoBuildResult> {
  const project = createProject({ title: 'The Northeastern Realms', projectionId: 'ATF:LCC' });
  project.meta.subtitle = 'A speculative political map';
  project.meta.dateLine = 'In the Year 1453';
  project.meta.author = 'After the Fall — demonstration map';
  project.oceanColor = '#cddfe9';
  project.landColor = '#e8e0cf';
  // This map is about North America, so it says so: Eurasian coastlines and
  // cities are never projected or drawn, and the view stays on the subject
  // instead of letting you zoom out to a thumbnail in the Atlantic. Project →
  // Map area clears it if you want to extend the alternate history elsewhere.
  project.workingExtent = [-130, 12, -50, 62];
  // Land and lakes together, never lakes alone: a lake is filled with the water
  // colour, so without land beneath it there is nothing for it to be a hole in
  // and it vanishes into the sea. With both on, the neighbouring land reads as
  // unclaimed ground in a neutral tone — which is how an atlas frames a region —
  // and the Great Lakes appear under the labels that name them.
  project.basemap = [
    { sourceId: 'world-land-10m', visible: true, opacity: 1 },
    { sourceId: 'world-lakes-10m', visible: true, opacity: 1 },
    { sourceId: 'world-rivers-10m', visible: false, opacity: 1 },
    { sourceId: 'world-roads-10m', visible: false, opacity: 1 },
    // Real cities on, drawn under the map's own: quiet hollow dots with grey
    // names, ranked by Natural Earth's scalerank so only the ones that carry a
    // regional view appear at this zoom. Where the two atlases name the same
    // place, the document's own settlement draws over the reference one.
    { sourceId: 'world-places-10m', visible: true, opacity: 1 },
    { sourceId: 'us-states', visible: false, opacity: 1 },
    { sourceId: 'us-counties', visible: false, opacity: 1 },
  ];

  const territoryLayer = findLayerByKind(project, 'territory')!;
  const settlementLayer = findLayerByKind(project, 'settlement')!;
  const riverLayer = findLayerByKind(project, 'river')!;
  const countryLabelLayer = Object.values(project.layers).find((l) => l.name === 'Country Labels')!;
  const regionLabelLayer = Object.values(project.layers).find((l) => l.name === 'Region Labels')!;
  const cityLabelLayer = Object.values(project.layers).find((l) => l.name === 'City Labels')!;
  const waterLabelLayer = Object.values(project.layers).find((l) => l.name === 'Water Labels')!;

  let states: Awaited<ReturnType<typeof loadBasemap>> = [];
  try {
    states = await loadBasemap('us-states');
  } catch {
    // Without the dataset there is nothing to demonstrate; hand back a blank map.
    return { project, center: [-74, 42], zoom: 6 };
  }

  const byName = new Map(states.map((f) => [basemapFeatureName(f).toLowerCase(), f]));

  /**
   * The coastline these realms are trimmed to.
   *
   * The Census cartographic file draws the whole of Massachusetts, Cape Cod
   * included, in 155 vertices. Under a coastline with a thousand times the
   * detail that reads as a fill cutting across every bay and clipping every
   * headland — a state map, drawn to state-map tolerances, sitting on a
   * shoreline drawn to none. Trimming puts the sea-facing edge of each realm on
   * the shore itself.
   *
   * Land only; the Great Lakes are a separate dataset and are not holes in it,
   * so a lakeside realm still covers its own share of the water. That is right:
   * inland water draws over the political fills (§17), so the lake reads as a
   * lake and the realm still owns the shore.
   */
  let coast: LandIndex | null = null;
  try {
    const land = landPolygonsOf(
      polygonsOf(await loadBasemap('world-land-10m')).map((f) => f.geometry as Polygon | MultiPolygon),
    );
    const stateShapes = states.map((f) => f.geometry as Polygon | MultiPolygon);
    coast = indexLand(land, boundsOf(stateShapes));
  } catch {
    // No coastline to hand: the realms are still perfectly usable, just drawn
    // at the resolution the state file came at.
  }
  const onCoast = (g: Polygon | MultiPolygon): Polygon | MultiPolygon =>
    (coast ? clipToLand(g, coast) : null) ?? g;

  for (const realm of REALMS) {
    const members = realm.members
      .map((m) => byName.get(m.toLowerCase()))
      .filter((f): f is NonNullable<typeof f> => !!f);
    if (members.length === 0) continue;

    const merged = dissolve(members.map((f) => onCoast(f.geometry as Polygon | MultiPolygon)));
    if (!merged) continue;

    const parentId = newId();
    const capitalId = newId();

    const parent: Territory = {
      id: parentId,
      layerId: territoryLayer.id,
      name: realm.name,
      shortName: realm.name.replace(/^(Kingdom|Duchy|Republic|Commonwealth|Marches) of /, ''),
      politicalType: realm.type,
      relationship: 'sovereign',
      parentId: null,
      liegeId: null,
      capitalId,
      notes: '',
      locked: false,
      hidden: false,
      timeline: { start: 1200, end: null },
      geometry: merged,
      styleClassId: STYLE_IDS.territoryDefault,
      styleOverrides: { fillColor: realm.color },
      inheritParentColor: false,
      borderKind: 'international',
      labelId: null,
    };

    const parentLabel: MapLabel = makeDemoLabel({
      layerId: countryLabelLayer.id,
      kind: 'country',
      text: realm.name,
      coords: interiorPoint(merged),
      styleClassId: STYLE_IDS.textCountry,
      attachedToId: parentId,
    });
    parent.labelId = parentLabel.id;
    project.territories[parentId] = parent;
    project.labels[parentLabel.id] = parentLabel;

    // Member states become subordinate provinces, tinted from the parent colour.
    if (members.length > 1) {
      for (const f of members) {
        const childId = newId();
        const name = basemapFeatureName(f);
        const child: Territory = {
          ...parent,
          id: childId,
          name,
          shortName: '',
          politicalType: 'duchy',
          parentId,
          capitalId: null,
          geometry: onCoast(f.geometry as Polygon | MultiPolygon),
          styleOverrides: {},
          inheritParentColor: true,
          borderKind: 'subordinate',
          labelId: null,
        };
        const childLabel = makeDemoLabel({
          layerId: regionLabelLayer.id,
          kind: 'region',
          text: name,
          coords: interiorPoint(child.geometry),
          styleClassId: STYLE_IDS.textRegion,
          attachedToId: childId,
        });
        child.labelId = childLabel.id;
        project.territories[childId] = child;
        project.labels[childLabel.id] = childLabel;
      }
    }

    // Capital, then the rest of the settlements.
    const capital: Settlement = {
      id: capitalId,
      layerId: settlementLayer.id,
      name: realm.capital.name,
      notes: '',
      locked: false,
      hidden: false,
      timeline: { start: null, end: null },
      type: 'national-capital',
      geometry: { type: 'Point', coordinates: [realm.capital.lon, realm.capital.lat] },
      population: null,
      ownerId: parentId,
      styleClassId: STYLE_IDS.symbolCapitalNational,
      styleOverrides: {},
      labelId: null,
    };
    const capitalLabel = makeDemoLabel({
      layerId: cityLabelLayer.id,
      kind: 'city',
      text: capital.name,
      coords: [realm.capital.lon, realm.capital.lat],
      styleClassId: STYLE_IDS.textCapital,
      attachedToId: capitalId,
      offset: [11, 0],
    });
    capital.labelId = capitalLabel.id;
    project.settlements[capitalId] = capital;
    project.labels[capitalLabel.id] = capitalLabel;

    for (const city of realm.cities) {
      const id = newId();
      const settlement: Settlement = {
        ...capital,
        id,
        name: city.name,
        type: city.type,
        geometry: { type: 'Point', coordinates: [city.lon, city.lat] },
        styleClassId: symbolForType(city.type),
        labelId: null,
      };
      const label = makeDemoLabel({
        layerId: cityLabelLayer.id,
        kind: 'city',
        text: city.name,
        coords: [city.lon, city.lat],
        styleClassId: STYLE_IDS.textCity,
        attachedToId: id,
        offset: [8, 0],
      });
      settlement.labelId = label.id;
      project.settlements[id] = settlement;
      project.labels[label.id] = label;
    }
  }

  // A disputed zone, to exercise hatch fills and the disputed border style.
  const disputed = byName.get('west virginia');
  if (disputed) {
    const id = newId();
    project.territories[id] = {
      id,
      layerId: territoryLayer.id,
      name: 'The Contested Marches',
      shortName: '',
      relationship: 'disputed',
      politicalType: 'disputed-territory',
      parentId: null,
      liegeId: null,
      capitalId: null,
      notes: 'Claimed by both Pennsylvania and the southern realms.',
      locked: false,
      hidden: false,
      timeline: { start: 1420, end: null },
      geometry: onCoast(disputed.geometry as Polygon | MultiPolygon),
      styleClassId: STYLE_IDS.territoryDisputed,
      styleOverrides: {},
      inheritParentColor: false,
      borderKind: 'disputed',
      labelId: null,
    };
    const label = makeDemoLabel({
      layerId: regionLabelLayer.id,
      kind: 'region',
      text: 'CONTESTED MARCHES',
      coords: interiorPoint(project.territories[id].geometry),
      styleClassId: STYLE_IDS.textRegion,
      attachedToId: id,
    });
    project.territories[id].labelId = label.id;
    project.labels[label.id] = label;
  }

  // Rivers, with labels that follow the river line (§16, §12).
  for (const river of RIVERS) {
    const id = newId();
    project.linearFeatures[id] = {
      id,
      layerId: riverLayer.id,
      name: `${river.name} River`,
      notes: '',
      locked: false,
      hidden: false,
      timeline: { start: null, end: null },
      kind: 'river-major',
      geometry: { type: 'LineString', coordinates: river.coords },
      styleClassId: STYLE_IDS.lineRiverMajor,
      styleOverrides: {},
      flowsIntoId: null,
      smoothing: 0,
      labelId: null,
    };
    const mid = river.coords[Math.floor(river.coords.length / 2)];
    const label = makeDemoLabel({
      layerId: waterLabelLayer.id,
      kind: 'river',
      text: river.name,
      coords: mid,
      styleClassId: STYLE_IDS.textRiver,
      attachedToId: id,
    });
    label.pathId = id; // text follows the river (§12)
    project.linearFeatures[id].labelId = label.id;
    project.labels[label.id] = label;
  }

  for (const w of WATER_LABELS) {
    const label = makeDemoLabel({
      layerId: waterLabelLayer.id,
      kind: w.kind,
      text: w.text,
      coords: [w.lon, w.lat],
      styleClassId: w.kind === 'ocean' ? STYLE_IDS.textOcean : STYLE_IDS.textWater,
      manualPosition: true,
    });
    project.labels[label.id] = label;
  }

  for (const rgn of REGION_LABELS) {
    const label = makeDemoLabel({
      layerId: regionLabelLayer.id,
      kind: 'region',
      text: rgn.text,
      coords: [rgn.lon, rgn.lat],
      styleClassId: STYLE_IDS.textRegion,
      manualPosition: true,
    });
    project.labels[label.id] = label;
  }

  project.view = { center: [-74.5, 41.6], zoom: 6.2, rotation: 0 };
  return { project, center: [-74.5, 41.6], zoom: 6.2 };
}

function symbolForType(type: Settlement['type']): string {
  switch (type) {
    case 'national-capital':
      return STYLE_IDS.symbolCapitalNational;
    case 'regional-capital':
      return STYLE_IDS.symbolCapitalRegional;
    case 'town':
      return STYLE_IDS.symbolTown;
    case 'village':
      return STYLE_IDS.symbolVillage;
    case 'fortress':
      return STYLE_IDS.symbolFortress;
    case 'port':
      return STYLE_IDS.symbolPort;
    case 'monastery':
      return STYLE_IDS.symbolMonastery;
    case 'ruins':
      return STYLE_IDS.symbolRuins;
    default:
      return STYLE_IDS.symbolCity;
  }
}

function makeDemoLabel(init: {
  layerId: string;
  kind: MapLabel['kind'];
  text: string;
  coords: [number, number] | number[];
  styleClassId: string;
  attachedToId?: string;
  offset?: [number, number];
  manualPosition?: boolean;
  fixedSize?: boolean;
}): MapLabel {
  return {
    id: newId(),
    layerId: init.layerId,
    name: init.text,
    notes: '',
    locked: false,
    hidden: false,
    timeline: { start: null, end: null },
    kind: init.kind,
    text: init.text,
    anchor: { type: 'Point', coordinates: [init.coords[0], init.coords[1]] },
    attachedToId: init.attachedToId ?? null,
    manualPosition: init.manualPosition ?? false,
    offset: init.offset ?? [0, 0],
    rotation: 0,
    styleClassId: init.styleClassId,
    styleOverrides: {},
    pathId: null,
    ignoreCollisions: false,
    fixedSize: init.fixedSize ?? defaultFixedSize(init.kind),
    maxWidth: null,
  };
}

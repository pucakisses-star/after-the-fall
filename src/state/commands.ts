/**
 * High-level editing commands.
 *
 * Everything the toolbar, context menu and keyboard shortcuts invoke lives here,
 * so a feature exists in exactly one place regardless of how many UI affordances
 * point at it.
 */

import type { LineString, Polygon, MultiPolygon, Position } from 'geojson';
import { newId } from '@/model/ids';
import {
  STYLE_IDS,
  politicalTypeInfo,
  relationshipInfo,
  settlementTypeForPlace,
  settlementTypeInfo,
} from '@/model/defaults';
import { depthOf, descendantsOf, relationshipSubtitle, wouldCreateCycle } from '@/model/hierarchy';
import { inheritedFill, resolveTerritoryStyle } from '@/model/resolveStyle';
import {
  areaKm2,
  bbox,
  difference,
  dissolve,
  dropSlivers,
  explode,
  makeValid,
  interiorPoint,
  intersection,
  normalizePoly,
  removeTinyParts,
  simplify,
  smoothPolygon,
  splitPolygon,
  union,
} from '@/geo/operations';
import type { Poly } from '@/geo/operations';
import { propagateVertexEdit, repairTopology, type RepairOptions } from '@/geo/topology';
import { boundaryFollows, reshapeBoundary } from '@/geo/reshape';
import { BARRIER_WIDTH_KM, neighbourHoldingMostOf, regionAt } from '@/geo/floodFill';
import { recolor, type RecolorOptions } from '@/geo/palette';
import { boundsOf, clipToLand, indexLand, landPolygonsOf } from '@/geo/coastline';
import { coastlineIfLoaded } from '@/io/importers';
import type { Recorder } from './history';
import type {
  MapLabel,
  MapLayer,
  MapProject,
  PoliticalRelationship,
  Settlement,
  SettlementType,
  Territory,
  UUID,
} from '@/model/types';
import {
  commit,
  getProject,
  makeLabel,
  makeLayer,
  makeSettlement,
  makeTerritory,
  useProjectStore,
} from './projectStore';
import { toast, useUIStore } from './uiStore';

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

export type AnyKind = 'territory' | 'settlement' | 'label' | 'linear' | 'layer';

export function kindOf(project: MapProject, id: UUID): AnyKind | null {
  if (project.territories[id]) return 'territory';
  if (project.settlements[id]) return 'settlement';
  if (project.labels[id]) return 'label';
  if (project.linearFeatures[id]) return 'linear';
  if (project.layers[id]) return 'layer';
  return null;
}

export function selectedTerritories(project = getProject()): Territory[] {
  return useUIStore
    .getState()
    .selection.map((id) => project.territories[id])
    .filter((t): t is Territory => !!t);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * How much of a new shape has to lie inside an existing one to be part of it.
 *
 * Not all of it, because a border drawn by hand along a coast or against an
 * existing frontier will cross it by a pixel here and there, and a rule that
 * says "entirely inside" would answer "sovereign" for a province anybody
 * looking at the map would call a province. Not much less either: a shape half
 * in and half out is a new state overlapping an old one, which is a different
 * thing and not something to guess about.
 */
const ENCLOSED_SHARE = 0.9;

/**
 * Trim an edited shape to the land (spec §3, §5).
 *
 * No editing gesture can take a territory over the sea: a border drawn past the
 * coast means "to the coast", the way it does on a paper map, and the fill and
 * the generator already answer the same way. The trim uses the same coastline
 * they do, indexed around the shape so the boolean runs against a few pieces of
 * coast rather than a hemisphere.
 *
 * Before the coastline has loaded there is nothing to trim against and the
 * shape passes through — the tools warm the load when an editing tool is
 * picked, so in practice that window is the first seconds of a session.
 * Returns null for a shape that is entirely at sea.
 */
export function trimToLand(shape: Poly): Poly | null {
  const land = coastlineIfLoaded();
  if (!land?.length) return shape;
  const index = indexLand(landPolygonsOf(land), boundsOf([shape]));
  return (clipToLand(shape as Polygon | MultiPolygon, index) as Poly | null) ?? null;
}

/**
 * The territory a newly drawn shape belongs inside, if any (spec §7).
 *
 * The *smallest* one that contains it, because containment is nested: a border
 * drawn inside a county inside a duchy belongs to the county, and the duchy is
 * its grandparent rather than its parent.
 *
 * Locked territories are skipped — a lock means "do not let anything happen to
 * this", and quietly gaining a member is something happening to it.
 */
export function enclosingTerritory(project: MapProject, shape: Poly): Territory | null {
  const area = areaKm2(shape);
  if (!(area > 0)) return null;
  const box = bbox(shape);

  let best: Territory | null = null;
  let bestArea = Infinity;
  for (const t of Object.values(project.territories)) {
    if (t.hidden || t.locked) continue;
    const other = bbox(t.geometry);
    if (other[0] > box[2] || other[2] < box[0] || other[1] > box[3] || other[3] < box[1]) continue;

    const shared = intersection(t.geometry, shape);
    if (!shared || areaKm2(shared) < area * ENCLOSED_SHARE) continue;

    const size = areaKm2(t.geometry);
    if (size < bestArea) {
      best = t;
      bestArea = size;
    }
  }
  return best;
}

/**
 * Draw a territory (spec §5, §7).
 *
 * A border drawn inside a state is a border *of* that state: it makes a
 * subdivision, not a rival sovereign sitting on top of it. So a shape that lands
 * inside an existing territory joins it — as a member, with the colour and the
 * lighter border weight that go with being one — and only a shape drawn on open
 * ground stands alone. Redrawing a state's own outline is a different gesture
 * with its own tool, and is unaffected: this is what happens when you draw a new
 * line rather than move an existing one.
 *
 * The rank of the new border follows the depth it lands at, which is what stops
 * a county inside a duchy inside a kingdom from being drawn with the same weight
 * of line as the kingdom's own frontier.
 */
export function addTerritory(geometry: Polygon | MultiPolygon, init: Partial<Territory> = {}): UUID | null {
  const project = getProject();
  const cleaned0 = normalizePoly(geometry);
  if (!cleaned0) {
    toast('That shape is not a valid polygon.', 'warn');
    return null;
  }
  // To the coast and no further, however the shape got here.
  const cleaned = trimToLand(cleaned0);
  if (!cleaned) {
    toast('That shape is entirely at sea.', 'warn');
    return null;
  }
  const ui = useUIStore.getState();
  const host = init.parentId === undefined ? enclosingTerritory(project, cleaned) : null;
  // A subdivision is made of its parent's ground, so the tenth of the shape the
  // rule above tolerates hanging outside is trimmed rather than kept: a border
  // drawn by hand crosses the outline it was meant to follow, and a province
  // sticking out of its own realm into the neighbour is not what was drawn.
  const shape = (host && intersection(host.geometry, cleaned)) || cleaned;
  const inherited: Partial<Territory> = host
    ? {
        parentId: host.id,
        ...membershipPatch(),
        borderKind: depthOf(project, host.id) === 0 ? 'provincial' : 'county',
      }
    : {};
  const territory = makeTerritory(project, shape, {
    politicalType: ui.draftPoliticalType,
    name: init.name ?? nextName(project, 'territories', 'New Territory'),
    ...inherited,
    ...init,
  });
  const label = makeLabel(project, { type: 'Point', coordinates: interiorPoint(shape) }, {
    kind: rankOf(territory) <= 2 ? 'country' : 'region',
    text: territory.name,
    attachedToId: territory.id,
  });

  commit(host ? 'Draw subdivision' : 'Draw territory', (r) => {
    r.set('territories', { ...territory, labelId: label.id });
    r.set('labels', label);
    // Inside the command, so redo restores this selection too.
    useUIStore.getState().selectAndReveal([territory.id]);
  });
  // Said out loud, because a shape that quietly became somebody's province is a
  // surprise, and the Parent field in the inspector is not where you are looking
  // when you finish drawing.
  if (host) toast(`${territory.name} is a subdivision of ${host.name}.`, 'success');
  return territory.id;
}

export function addSettlement(
  coordinates: [number, number],
  init: Partial<Settlement> = {},
  opts: { showNames?: boolean } = {},
): UUID {
  const project = getProject();
  let id = '';
  commit('Place settlement', (r) => {
    id = recordSettlement(r, project, coordinates, { type: useUIStore.getState().draftSettlementType, ...init }, opts);
    useUIStore.getState().selectAndReveal([id]);
  });
  return id;
}

/**
 * Write a settlement and its name into a command in progress.
 *
 * Split out of `addSettlement` so that a caller which is *already* changing
 * something else can create a town as part of that change rather than beside it.
 * Appointing a capital is the case that wanted it: naming a city the map does
 * not have yet is one decision, and one press of undo should take it back.
 */
function recordSettlement(
  r: Recorder,
  project: MapProject,
  coordinates: [number, number],
  init: Partial<Settlement>,
  opts: { showNames?: boolean } = {},
): UUID {
  const settlement = makeSettlement(project, { type: 'Point', coordinates }, {
    name: init.name ?? nextName(project, 'settlements', 'New Settlement'),
    ownerId: territoryAt(project, coordinates)?.id ?? null,
    ...init,
  });
  const label = makeLabel(project, { type: 'Point', coordinates }, {
    kind: 'city',
    text: settlement.name,
    attachedToId: settlement.id,
    styleClassId: settlement.type.includes('capital') ? STYLE_IDS.textCapital : STYLE_IDS.textCity,
    offset: [settlementLabelOffset(settlement), 0],
  });

  r.set('settlements', { ...settlement, labelId: label.id });
  r.set('labels', label);
  // A name nobody can see is not much of a name. Asked for by the callers that
  // exist to put one on the map, and done inside the commit so switching the
  // layer on undoes with the settlement rather than being left behind.
  if (opts.showNames) {
    for (let layer = project.layers[label.layerId]; layer; layer = layer.parentId ? project.layers[layer.parentId] : undefined!) {
      if (!layer.visible) r.update<MapLayer>('layers', layer.id, { visible: true });
      if (!layer.parentId) break;
    }
  }
  return settlement.id;
}

/**
 * Take a reference city or town into the document (spec §47).
 *
 * The reference layer is a backdrop: four thousand real places, drawn quietly,
 * that you compose your own map against. They are not the document's and cannot
 * be edited — which is right for four thousand of them and wrong for the one you
 * have just decided is a city of your world and wants a different name.
 *
 * So clicking one adopts it: same position, same name, and a rank read off the
 * scale it was drawn at. From that moment it is an ordinary settlement — rename
 * it, move it, change what it is — and the reference layer stops drawing it,
 * because otherwise the old name sits under the new one saying the map has two.
 */
export interface ReferencePlace {
  name: string;
  coordinates: [number, number];
  scalerank: number;
  population?: number;
}

/** The settlement the document already has for a reference place, if any. */
function settlementFor(project: MapProject, place: ReferencePlace): Settlement | undefined {
  return Object.values(project.settlements).find(
    (s) =>
      s.name.trim().toLowerCase() === place.name.trim().toLowerCase() &&
      Math.abs(s.geometry.coordinates[0] - place.coordinates[0]) < 0.001 &&
      Math.abs(s.geometry.coordinates[1] - place.coordinates[1]) < 0.001,
  );
}

export function adoptPlace(place: ReferencePlace): UUID | null {
  const project = getProject();
  const already = settlementFor(project, place);
  if (already) {
    useUIStore.getState().selectAndReveal([already.id]);
    return already.id;
  }

  const id = addSettlement(
    place.coordinates,
    {
      name: place.name,
      type: settlementTypeForPlace(place),
      // The real population comes with it: it is what decided the rank, and a
      // map of a fallen world is more interesting for knowing what was there.
      population: place.population ?? null,
    },
    { showNames: true },
  );
  toast(`${place.name} is yours now — rename it in the inspector.`, 'success');
  return id;
}

/**
 * What the capital may be named as (spec §7, §47).
 *
 * Three kinds, because "which town does this realm run from" has three honest
 * answers on a map of an invented world: one the document already has, one the
 * reference gazetteer knows and the document has not taken yet, and one that
 * exists nowhere because you have just made it up.
 */
export type CapitalChoice =
  | { kind: 'none' }
  | { kind: 'settlement'; id: UUID }
  | { kind: 'place'; place: ReferencePlace }
  | { kind: 'new'; name: string; coordinates?: [number, number] };

/**
 * Appoint a territory's capital (spec §7).
 *
 * A capital is two facts that have to agree: the realm records which town it is
 * run from, and the town is drawn as a capital rather than as one dot among
 * hundreds. Setting only the first is what a bare `capitalId` did, and it left
 * the map saying nothing had happened.
 *
 * So this also moves the rank — up for the town appointed, and back down for the
 * one it replaces, unless some other realm is still run from there. The rank
 * matches the realm's standing: an empire's seat is an imperial capital, a
 * sovereign's a national one, and a province's a regional one. The town it
 * demotes goes back to the size its population says it is, which is where its
 * rank came from in the first place if the map adopted it from the gazetteer.
 *
 * Everything happens in one command, including creating the town when the name
 * is one the map has never heard of. Naming a capital is a single decision and
 * takes a single undo.
 */
export function setCapital(territoryId: UUID, choice: CapitalChoice): UUID | null {
  const project = getProject();
  const territory = project.territories[territoryId];
  if (!territory) return null;

  // Resolved before the command, since an existing town needs no writing.
  const existing =
    choice.kind === 'settlement'
      ? project.settlements[choice.id]
      : choice.kind === 'place'
        ? settlementFor(project, choice.place)
        : undefined;
  if (choice.kind === 'settlement' && !existing) return null;

  const rank = capitalRankFor(project, territory);
  const outgoing = territory.capitalId ? project.settlements[territory.capitalId] : undefined;

  let capitalId: UUID | null = null;
  commit(choice.kind === 'none' ? 'Clear capital' : 'Set capital', (r) => {
    if (choice.kind !== 'none') {
      if (existing) {
        capitalId = existing.id;
      } else if (choice.kind === 'place') {
        capitalId = recordSettlement(
          r,
          project,
          choice.place.coordinates,
          { name: choice.place.name, type: rank, population: choice.place.population ?? null },
          { showNames: true },
        );
      } else if (choice.kind === 'new') {
        // A town nobody has heard of goes in the middle of the country it runs,
        // which is somewhere to put it and somewhere to drag it from.
        const at = choice.coordinates ?? interiorPoint(territory.geometry);
        capitalId = recordSettlement(
          r,
          project,
          at,
          { name: choice.name, type: rank, ownerId: territory.id },
          { showNames: true },
        );
      }
    }

    if (outgoing && outgoing.id !== capitalId && outgoing.type.includes('capital')) {
      // Only if nothing else is run from there — one town can be the seat of a
      // duchy and of the county under it, and losing one of those posts is not
      // losing the other.
      const stillSeat = Object.values(project.territories).some(
        (t) => t.id !== territory.id && t.capitalId === outgoing.id,
      );
      if (!stillSeat) {
        const back = settlementTypeForPlace({ population: outgoing.population ?? undefined });
        r.update<Settlement>('settlements', outgoing.id, {
          type: back,
          styleClassId: settlementTypeInfo(back).styleClassId,
        });
        if (outgoing.labelId) {
          r.update<MapLabel>('labels', outgoing.labelId, { styleClassId: STYLE_IDS.textCity });
        }
      }
    }

    // An existing town is promoted; one written above already came out at rank.
    if (existing && existing.type !== rank) {
      r.update<Settlement>('settlements', existing.id, {
        type: rank,
        styleClassId: settlementTypeInfo(rank).styleClassId,
      });
      if (existing.labelId) {
        r.update<MapLabel>('labels', existing.labelId, {
          styleClassId: STYLE_IDS.textCapital,
          // A capital's symbol is the larger one, so its name stands further
          // off. The renderer would hold the name clear anyway; this keeps the
          // number in the inspector honest about where it actually is.
          ...(project.labels[existing.labelId]?.manualPosition
            ? {}
            : { offset: [settlementLabelOffset({ ...existing, type: rank }), 0] as [number, number] }),
        });
      }
    }

    r.update<Territory>('territories', territory.id, { capitalId });
  });

  return capitalId;
}

/** An empire's seat, a sovereign's, or a province's. */
function capitalRankFor(project: MapProject, t: Territory): SettlementType {
  if (String(t.politicalType) === 'empire') return 'imperial-capital';
  return t.parentId && project.territories[t.parentId] ? 'regional-capital' : 'national-capital';
}

function settlementLabelOffset(s: Settlement): number {
  return s.type.includes('capital') ? 11 : 8;
}

export function addLabel(coordinates: [number, number], init: Partial<MapLabel> = {}): UUID {
  const project = getProject();
  const ui = useUIStore.getState();
  const label = makeLabel(project, { type: 'Point', coordinates }, {
    kind: ui.draftLabelKind,
    text: init.text ?? 'New Label',
    manualPosition: true,
    ...init,
  });
  commit('Add label', (r) => {
    r.set('labels', label);
    useUIStore.getState().selectAndReveal([label.id]);
  });
  return label.id;
}

/** Which territory contains a lon/lat, deepest match first. */
export function territoryAt(project: MapProject, coordinates: [number, number]): Territory | null {
  let best: Territory | null = null;
  let bestArea = Infinity;
  for (const t of Object.values(project.territories)) {
    if (t.hidden) continue;
    if (!pointInPoly(coordinates, t.geometry)) continue;
    const a = areaKm2(t.geometry);
    if (a < bestArea) {
      best = t;
      bestArea = a;
    }
  }
  return best;
}

/** Does a territory's ground include this point? Used to rank capital candidates. */
export function territoryContains(t: Territory, coordinates: [number, number]): boolean {
  return pointInPoly(coordinates, t.geometry);
}

function pointInPoly([x, y]: [number, number], g: Poly): boolean {
  const rings = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of rings) {
    if (!ringContains(poly[0], x, y)) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (ringContains(poly[i], x, y)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Standard ray-casting point-in-ring. */
function ringContains(ring: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function rankOf(t: Territory): number {
  return politicalTypeInfo(t.politicalType)?.rank ?? 3;
}

function nextName(project: MapProject, key: 'territories' | 'settlements', base: string): string {
  const existing = new Set(Object.values(project[key]).map((v) => (v as { name: string }).name));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${base} ${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Geometry editing
// ---------------------------------------------------------------------------

/**
 * Write a new geometry for a territory and, when the shared-border system is on,
 * carry the same vertex moves into its neighbours (spec §6).
 */
export function updateTerritoryGeometry(id: UUID, geometry: Poly, label = 'Edit territory'): void {
  const project = getProject();
  const current = project.territories[id];
  if (!current || current.locked) return;
  const valid = normalizePoly(geometry);
  // A vertex dragged out to sea goes to the coast and stops, like every other
  // way of pushing a border at the water.
  const cleaned = valid && trimToLand(valid);
  if (!cleaned) return;

  const shared = useUIStore.getState().snapEnabled
    ? propagateVertexEdit(Object.values(project.territories), id, current.geometry, cleaned)
    : new Map<UUID, Poly>();

  commit(label, (r) => {
    r.update<Territory>('territories', id, { geometry: cleaned });
    for (const [nid, geom] of shared) {
      r.update<Territory>('territories', nid, { geometry: geom });
    }
    syncAttachedLabel(r, id, cleaned);
  });

  if (shared.size > 0) {
    useUIStore
      .getState()
      .setStatus(`Shared border: ${shared.size} neighbouring territor${shared.size === 1 ? 'y' : 'ies'} updated`);
    setTimeout(() => useUIStore.getState().setStatus(null), 2500);
  }
}

/** Keep an automatically-placed label centred on its territory. */
function syncAttachedLabel(r: { project: MapProject; update: Function }, territoryId: UUID, geometry: Poly): void {
  const project = r.project as MapProject;
  const t = project.territories[territoryId];
  if (!t?.labelId) return;
  const label = project.labels[t.labelId];
  if (!label || label.manualPosition) return;
  const [lon, lat] = interiorPoint(geometry);
  (r.update as (k: string, id: string, c: Partial<MapLabel>) => void)('labels', label.id, {
    anchor: { type: 'Point', coordinates: [lon, lat] },
  });
}

export function moveSettlement(id: UUID, coordinates: [number, number]): void {
  const project = getProject();
  const s = project.settlements[id];
  if (!s || s.locked) return;
  commit('Move settlement', (r) => {
    r.update<Settlement>('settlements', id, { geometry: { type: 'Point', coordinates } });
    if (s.labelId && project.labels[s.labelId] && !project.labels[s.labelId].manualPosition) {
      r.update<MapLabel>('labels', s.labelId, { anchor: { type: 'Point', coordinates } });
    }
  });
}

export function moveLabel(id: UUID, coordinates: [number, number]): void {
  const project = getProject();
  const l = project.labels[id];
  if (!l || l.locked) return;
  commit('Move label', (r) =>
    r.update<MapLabel>('labels', id, {
      anchor: { type: 'Point', coordinates },
      manualPosition: true,
      offset: [0, 0],
    }),
  );
}

// ---------------------------------------------------------------------------
// Territory operations (spec §5)
// ---------------------------------------------------------------------------

/** Merge the selected territories into the first one. */
export function mergeSelected(): void {
  const project = getProject();
  const sel = selectedTerritories(project);
  if (sel.length < 2) {
    toast('Select two or more territories to merge.', 'warn');
    return;
  }
  const keeper = sel[0];
  const merged = union(sel.map((t) => t.geometry));
  if (!merged) {
    toast('Could not merge those shapes.', 'error');
    return;
  }
  const absorbed = sel.slice(1);

  commit('Merge territories', (r) => {
    r.update<Territory>('territories', keeper.id, { geometry: merged });
    for (const t of absorbed) {
      // Re-home children so the hierarchy does not lose a branch.
      for (const child of descendantsOf(project, t.id)) {
        if (child.parentId === t.id) r.update<Territory>('territories', child.id, { parentId: keeper.id });
      }
      if (t.labelId) r.remove('labels', t.labelId);
      r.remove('territories', t.id);
    }
    syncAttachedLabel(r, keeper.id, merged);
    useUIStore.getState().setSelection([keeper.id]);
  });
  toast(`Merged ${sel.length} territories into "${keeper.name}".`, 'success');
}

/**
 * Create a new parent territory from the selection, dissolving their internal
 * borders and keeping the originals as subordinate divisions (spec §55).
 */
export function createTerritoryFromSelection(init: Partial<Territory> = {}): UUID | null {
  const project = getProject();
  const sel = selectedTerritories(project);
  if (sel.length === 0) {
    toast('Select the divisions to combine first.', 'warn');
    return null;
  }
  const merged = dissolve(sel.map((t) => t.geometry));
  if (!merged) {
    toast('Could not dissolve those shapes.', 'error');
    return null;
  }

  const ui = useUIStore.getState();
  const parent = makeTerritory(project, merged, {
    name: init.name ?? nextName(project, 'territories', 'New State'),
    politicalType: init.politicalType ?? ui.draftPoliticalType,
    ...init,
  });
  const label = makeLabel(project, { type: 'Point', coordinates: interiorPoint(merged) }, {
    kind: 'country',
    text: parent.name,
    attachedToId: parent.id,
  });

  commit('Create territory from selection', (r) => {
    r.set('territories', { ...parent, labelId: label.id });
    r.set('labels', label);
    for (const t of sel) {
      // Preserve the originals as children, demoted to a subordinate border weight.
      r.update<Territory>('territories', t.id, {
        parentId: parent.id,
        ...membershipPatch(),
        // Each keeps whatever weight it already had, unless it was a sovereign
        // frontier — which it no longer is.
        borderKind: t.borderKind === 'international' ? 'provincial' : t.borderKind,
      });
      // Their own labels become region labels rather than country labels.
      if (t.labelId && project.labels[t.labelId]?.kind === 'country') {
        r.update<MapLabel>('labels', t.labelId, { kind: 'region', styleClassId: STYLE_IDS.textRegion });
      }
    }
    useUIStore.getState().selectAndReveal([parent.id]);
  });
  toast(`Created "${parent.name}" from ${sel.length} divisions.`, 'success');
  return parent.id;
}

/** Cut the selected territory with a drawn line (spec §5). */
export function splitTerritoryWithLine(territoryId: UUID, cutter: LineString): void {
  const project = getProject();
  const t = project.territories[territoryId];
  if (!t || t.locked) return;

  const pieces = splitPolygon(t.geometry, cutter);
  if (!pieces || pieces.length < 2) {
    toast('The cut line must cross the territory from edge to edge.', 'warn');
    return;
  }

  // Largest piece keeps the original identity; the rest become new territories.
  const sorted = [...pieces].sort((a, b) => areaKm2(b) - areaKm2(a));
  const newIds: UUID[] = [territoryId];

  commit('Split territory', (r) => {
    r.update<Territory>('territories', territoryId, { geometry: sorted[0] });
    syncAttachedLabel(r, territoryId, sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
      const piece = makeTerritory(project, sorted[i], {
        name: `${t.name} (${i + 1})`,
        politicalType: t.politicalType,
        parentId: t.parentId,
        styleClassId: t.styleClassId,
        styleOverrides: { ...t.styleOverrides },
        borderKind: t.borderKind,
        layerId: t.layerId,
      });
      const label = makeLabel(project, { type: 'Point', coordinates: interiorPoint(sorted[i]) }, {
        kind: project.labels[t.labelId ?? '']?.kind ?? 'region',
        text: piece.name,
        attachedToId: piece.id,
      });
      r.set('territories', { ...piece, labelId: label.id });
      r.set('labels', label);
      newIds.push(piece.id);
    }
    useUIStore.getState().selectAndReveal(newIds);
  });
  toast(`Split into ${pieces.length} pieces.`, 'success');
}

/** Subtract the second-and-later selected territories from the first (§5: enclaves). */
export function subtractSelected(): void {
  const project = getProject();
  const sel = selectedTerritories(project);
  if (sel.length < 2) {
    toast('Select the target first, then the shapes to subtract.', 'warn');
    return;
  }
  const target = sel[0];
  let geom: Poly | null = target.geometry;
  for (const other of sel.slice(1)) {
    if (!geom) break;
    geom = difference(geom, other.geometry);
  }
  if (!geom) {
    toast('Subtracting would erase the target entirely.', 'warn');
    return;
  }
  const result = geom;
  commit('Subtract territories', (r) => {
    r.update<Territory>('territories', target.id, { geometry: result });
    syncAttachedLabel(r, target.id, result);
  });
  toast(`Subtracted from "${target.name}".`, 'success');
}

/** Assign subdivisions to a state, dissolving them in (spec §56, the paint tool). */
export function paintTerritory(targetId: UUID, sourceIds: UUID[]): void {
  const project = getProject();
  const target = project.territories[targetId];
  if (!target || target.locked) return;
  const sources = sourceIds
    .map((id) => project.territories[id])
    .filter((t): t is Territory => !!t && t.id !== targetId && !t.locked);
  if (sources.length === 0) return;

  commit('Assign to state', (r) => {
    for (const s of sources) {
      r.update<Territory>('territories', s.id, {
        parentId: targetId,
        ...membershipPatch(),
        // Painting assigns small subdivisions to a state, so their edges are
        // county lines whatever the default for a constituent is.
        borderKind: 'county',
      });
    }
    // The parent's own outline is the union of everything assigned to it.
    const merged = union([target.geometry, ...sources.map((s) => s.geometry)]);
    if (merged) {
      r.update<Territory>('territories', targetId, { geometry: merged });
      syncAttachedLabel(r, targetId, merged);
    }
  });
}

/**
 * The patch that makes a territory a member of the realm it is being given to.
 *
 * Every command that hands a territory a parent has to set its constitutional
 * status at the same time, and the reason is not tidiness. Inheritance is driven
 * by status, and a sovereign's variation is zero by definition — so a territory
 * left `sovereign` while pointed at a parent and told to inherit takes that
 * parent's *exact* fill and disappears into it. Painting a province into a realm
 * looked like it had done nothing at all.
 *
 * Keeping the three fields together in one place is what stops the next command
 * setting two of them and forgetting the third. `borderKind` is only a default:
 * callers with a reason to draw a different weight say so after spreading this.
 */
export function membershipPatch(
  relationship: PoliticalRelationship = 'constituent',
): Partial<Territory> {
  const info = relationshipInfo(relationship);
  return {
    relationship,
    // A free city sits inside a realm without being a shade of it.
    inheritParentColor: !info.ownColor,
    borderKind: info.border,
  };
}

/**
 * Give the ground under a point to one realm — the paint bucket (spec §6, §57).
 *
 * Wilderness joins a neighbour: the whole connected patch of it, out to the
 * coast and up to whatever anyone else already holds. Ground somebody holds
 * changes hands instead — the same click, the same region-finding, and the old
 * owner loses exactly what the new one gains, so no ground is created or
 * destroyed by a fill.
 *
 * Which realm receives it is decided the way the generator decides it when
 * filling a landlocked pocket: whoever holds most of that ground's edge already.
 * An explicit selection wins over that, because a user who selected a realm
 * first has said which one they mean — and for claimed ground it is the only
 * sensible answer, so a fill there without a selection asks for one rather than
 * guessing which neighbour should annex a province.
 *
 * `walls` are lines the fill may not cross: rivers, boundaries, anything the map
 * is drawing that the user has left switched on. They are cut out of the region
 * before the patch under the pointer is chosen, which is what makes "give this
 * realm everything on its side of the river" one click.
 *
 * The coastline and the walls have to be supplied rather than fetched here,
 * because loading them is asynchronous and this has to stay a synchronous,
 * undoable command.
 */
export function fillLandAt(
  point: [number, number],
  land: Poly[],
  preferredId: UUID | null = null,
  walls: Position[][] = [],
): { filled: boolean; message: string } {
  const project = getProject();
  const claimed = Object.values(project.territories).filter((t) => !t.hidden);

  const region = regionAt(point, land, claimed, walls);
  if (!region) {
    return { filled: false, message: 'No land there — that looks like open water.' };
  }

  const owner = region.ownerId ? project.territories[region.ownerId] : null;
  const preferred = preferredId ? project.territories[preferredId] : undefined;

  // Nobody would annex a province by accident, so claimed ground is only ever
  // moved to a realm the user named.
  if (owner && !preferred) {
    return {
      filled: false,
      message: `That ground belongs to ${owner.name}. Select the realm it should join, then click again.`,
    };
  }

  const target =
    preferred && !preferred.locked
      ? preferred
      : neighbourHoldingMostOf(region.geometry, claimed.filter((t) => !t.locked), FILL_NEIGHBOUR_TOLERANCE);

  if (!target) {
    return {
      filled: false,
      message: 'Nothing borders that ground. Select the realm it should join, then click again.',
    };
  }
  if (target.locked) return { filled: false, message: `${target.name} is locked.` };
  if (owner && owner.id === target.id) {
    return { filled: false, message: `${target.name} already holds that ground.` };
  }
  if (owner?.locked) return { filled: false, message: `${owner.name} is locked.` };

  // What the old owner keeps, and then — exactly — what it does not.
  //
  // The order matters. Working out the two sides independently is what leaves
  // threads on the map: the region comes back from a buffer and the remainder
  // from a subtraction, and where those two boundaries almost but not quite
  // agree the subtraction leaves a metre-wide splinter that belongs to nobody
  // and draws as a black hook lying across the ground. So the remainder is
  // cleaned of anything narrower than the line that cut it, and the ground that
  // changes hands is then defined as everything the old owner no longer holds.
  // Nothing is dropped from the map — a splinter is absorbed by the realm beside
  // it, which is the realm it was cut away from.
  const cut = owner ? difference(owner.geometry, region.geometry) : null;
  const kept = cut && dropSlivers(cut, BARRIER_WIDTH_KM);
  // A boolean that cancels two shapes leaves a ring with no area. Not ground,
  // and not something to leave a realm holding.
  const remainder = kept && areaKm2(kept) > 0 ? kept : null;
  const taken = owner
    ? (remainder ? difference(owner.geometry, remainder) : owner.geometry) ?? region.geometry
    : region.geometry;

  const merged = union([target.geometry, taken]);
  if (!merged) return { filled: false, message: 'Could not merge that ground into the realm.' };

  const area = Math.round(areaKm2(taken));
  commit(owner ? 'Fill territory' : 'Fill unclaimed land', (r) => {
    if (owner) {
      if (remainder) {
        r.update<Territory>('territories', owner.id, { geometry: remainder });
        syncAttachedLabel(r, owner.id, remainder);
      } else {
        for (const label of Object.values(getProject().labels)) {
          if (label.attachedToId === owner.id) r.remove('labels', label.id);
        }
        r.remove('territories', owner.id);
      }
    }
    r.update<Territory>('territories', target.id, { geometry: merged });
    syncAttachedLabel(r, target.id, merged);
  });

  const from = owner ? ` from ${owner.name}` : '';
  const gone = owner && !remainder ? ` ${owner.name} held nothing else, so it is gone.` : '';
  return {
    filled: true,
    message: region.truncated
      ? `Added ${area.toLocaleString()} km²${from} to ${target.name} — the region ran past the fill limit, so click again to continue.`
      : `Added ${area.toLocaleString()} km²${from} to ${target.name}.${gone}`,
  };
}

/** @deprecated The bucket fills claimed ground too now; call `fillLandAt`. */
export const fillUnclaimedAt = fillLandAt;

/**
 * How close a region's vertex has to be to a territory's edge to count as
 * bordering it, in degrees — about 3 km, which is under the width of the
 * coastline detail and well over the rounding in the stored geometry.
 */
export const FILL_NEIGHBOUR_TOLERANCE = 0.03;

// ---------------------------------------------------------------------------
// Cleanup (spec §58)
// ---------------------------------------------------------------------------

export function simplifySelection(tolerance: number): void {
  const sel = selectedTerritories();
  if (sel.length === 0) return;
  commit('Simplify geometry', (r) => {
    for (const t of sel) {
      if (t.locked) continue;
      r.update<Territory>('territories', t.id, { geometry: simplify(t.geometry, tolerance) });
    }
  });
  toast(`Simplified ${sel.length} territories.`, 'success');
}

export function smoothSelection(iterations: number): void {
  const sel = selectedTerritories();
  if (sel.length === 0) return;
  commit('Smooth geometry', (r) => {
    for (const t of sel) {
      if (t.locked) continue;
      r.update<Territory>('territories', t.id, { geometry: smoothPolygon(t.geometry, iterations) });
    }
  });
}

export function removeTinyPolygons(minKm2: number): void {
  const project = getProject();
  let changed = 0;
  commit('Remove tiny polygons', (r) => {
    for (const t of Object.values(project.territories)) {
      if (t.locked) continue;
      const next = removeTinyParts(t.geometry, minKm2);
      if (!next) continue;
      if (explode(next).length !== explode(t.geometry).length) {
        r.update<Territory>('territories', t.id, { geometry: next });
        changed++;
      }
    }
  });
  toast(changed ? `Cleaned ${changed} territories.` : 'Nothing smaller than the threshold.', 'success');
}

export function runRepairTopology(options: RepairOptions = {}): { log: string[]; changed: number } {
  const project = getProject();
  const territories = Object.values(project.territories);
  const locked = new Set(territories.filter((t) => t.locked).map((t) => t.id));
  const result = repairTopology(territories, { ...options, lockedIds: locked });

  if (result.changes.size > 0) {
    commit('Repair territory topology', (r) => {
      for (const [id, geom] of result.changes) {
        r.update<Territory>('territories', id, { geometry: geom });
        syncAttachedLabel(r, id, geom);
      }
    });
  }
  return { log: result.log, changed: result.changes.size };
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

export function setTerritoryFill(ids: UUID[], fillColor: string): void {
  const project = getProject();
  commit('Recolour territory', (r) => {
    for (const id of ids) {
      const t = project.territories[id];
      if (!t || t.locked) continue;
      r.update<Territory>('territories', id, {
        styleOverrides: { ...t.styleOverrides, fillColor },
        inheritParentColor: false,
      });
    }
  });
}

/** "Recolor Political Map" (spec §22). */
export function recolorPoliticalMap(opts: RecolorOptions): void {
  const project = getProject();
  // Only colour the sovereign level; children that inherit follow automatically.
  const all = Object.values(project.territories);
  const targets = all.filter((t) => !t.inheritParentColor);
  if (targets.length === 0) {
    toast('Every territory inherits its colour from a parent — nothing to recolour.', 'warn');
    return;
  }
  const assignments = recolor(targets, (t) => resolveTerritoryStyle(project, t).fillColor, opts);
  if (assignments.size === 0) {
    toast('All territories are locked.', 'warn');
    return;
  }
  commit('Recolour political map', (r) => {
    for (const [id, color] of assignments) {
      const t = project.territories[id];
      if (!t) continue;
      r.update<Territory>('territories', id, { styleOverrides: { ...t.styleOverrides, fillColor: color } });
    }
  });
  toast(`Recoloured ${assignments.size} territories.`, 'success');
}

/** Bulk edit (spec §39). Applies a shallow patch to every selected feature of a kind. */
export function bulkUpdate(patch: {
  territory?: Partial<Territory>;
  settlement?: Partial<Settlement>;
  label?: Partial<MapLabel>;
}): void {
  const project = getProject();
  const sel = useUIStore.getState().selection;
  commit('Bulk edit', (r) => {
    for (const id of sel) {
      if (patch.territory && project.territories[id]) r.update<Territory>('territories', id, patch.territory);
      if (patch.settlement && project.settlements[id]) r.update<Settlement>('settlements', id, patch.settlement);
      if (patch.label && project.labels[id]) r.update<MapLabel>('labels', id, patch.label);
    }
  });
}

// ---------------------------------------------------------------------------
// Generic feature commands
// ---------------------------------------------------------------------------

export function deleteSelection(): void {
  const project = getProject();
  const sel = useUIStore.getState().selection;
  if (sel.length === 0) return;

  commit('Delete', (r) => {
    for (const id of sel) {
      const t = project.territories[id];
      if (t) {
        if (t.labelId) r.remove('labels', t.labelId);
        // Orphaned children rise to the deleted territory's own parent.
        for (const child of Object.values(project.territories)) {
          if (child.parentId === id) r.update<Territory>('territories', child.id, { parentId: t.parentId });
        }
        r.remove('territories', id);
        continue;
      }
      const s = project.settlements[id];
      if (s) {
        if (s.labelId) r.remove('labels', s.labelId);
        r.remove('settlements', id);
        continue;
      }
      const lf = project.linearFeatures[id];
      if (lf) {
        if (lf.labelId) r.remove('labels', lf.labelId);
        r.remove('linearFeatures', id);
        continue;
      }
      if (project.labels[id]) {
        // Detach from its owner so nothing points at a dead id.
        for (const owner of [
          ...Object.values(project.territories),
          ...Object.values(project.settlements),
          ...Object.values(project.linearFeatures),
        ]) {
          if (owner.labelId === id) {
            const key =
              project.territories[owner.id] ? 'territories'
              : project.settlements[owner.id] ? 'settlements'
              : 'linearFeatures';
            r.update(key, owner.id, { labelId: null } as never);
          }
        }
        r.remove('labels', id);
      }
    }
  });
  useUIStore.getState().clearSelection();
}

export function duplicateSelection(): void {
  const project = getProject();
  const sel = useUIStore.getState().selection;
  if (sel.length === 0) return;
  const created: UUID[] = [];
  // Nudge duplicates so they are visibly distinct from the original.
  const OFFSET = 0.12;

  commit('Duplicate', (r) => {
    for (const id of sel) {
      const t = project.territories[id];
      if (t) {
        const geometry = translatePoly(t.geometry, OFFSET, -OFFSET);
        const copy = makeTerritory(project, geometry, {
          ...t,
          id: newId(),
          name: `${t.name} copy`,
          labelId: null,
          geometry,
        });
        const label = makeLabel(project, { type: 'Point', coordinates: interiorPoint(geometry) }, {
          kind: 'region',
          text: copy.name,
          attachedToId: copy.id,
        });
        r.set('territories', { ...copy, labelId: label.id });
        r.set('labels', label);
        created.push(copy.id);
        continue;
      }
      const s = project.settlements[id];
      if (s) {
        const coords: [number, number] = [
          s.geometry.coordinates[0] + OFFSET,
          s.geometry.coordinates[1] - OFFSET,
        ];
        const copy = makeSettlement(project, { type: 'Point', coordinates: coords }, {
          ...s,
          id: newId(),
          name: `${s.name} copy`,
          labelId: null,
        });
        const label = makeLabel(project, { type: 'Point', coordinates: coords }, {
          kind: 'city',
          text: copy.name,
          attachedToId: copy.id,
        });
        r.set('settlements', { ...copy, labelId: label.id });
        r.set('labels', label);
        created.push(copy.id);
        continue;
      }
      const l = project.labels[id];
      if (l) {
        const copy: MapLabel = {
          ...l,
          id: newId(),
          text: l.text,
          attachedToId: null,
          manualPosition: true,
          anchor: {
            type: 'Point',
            coordinates: [l.anchor.coordinates[0] + OFFSET, l.anchor.coordinates[1] - OFFSET],
          },
        };
        r.set('labels', copy);
        created.push(copy.id);
      }
    }
    if (created.length) useUIStore.getState().setSelection(created);
  });
}

function translatePoly(g: Poly, dx: number, dy: number): Poly {
  const mapRing = (ring: number[][]) => ring.map(([x, y]) => [x + dx, y + dy]);
  return g.type === 'Polygon'
    ? { type: 'Polygon', coordinates: g.coordinates.map(mapRing) }
    : { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(mapRing)) };
}

export function setParent(childId: UUID, parentId: UUID | null): void {
  const project = getProject();
  if (wouldCreateCycle(project, childId, parentId)) {
    toast('That would make a territory its own ancestor.', 'error');
    return;
  }
  commit('Set parent', (r) => r.update<Territory>('territories', childId, { parentId }));
}

/**
 * Change a territory's constitutional status, and everything that follows from
 * it (spec §35).
 *
 * The whole argument for holding status as data is that this is one edit. Making
 * Dubuque independent has to give it a sovereign frontier, take it out of the
 * Confederation's colour family, drop the "Vassal of the M.C." line and remove
 * it from the union the Confederation's outer border is derived from — and a
 * user who had to do those five things by hand would get one of them wrong and
 * have a map that lies about its own politics.
 *
 * The frontier and the union need no work here: `computeBorders` derives both
 * from the parent chain every time it runs.
 */
export function setRelationship(id: UUID, relationship: PoliticalRelationship): void {
  const project = getProject();
  const t = project.territories[id];
  if (!t) return;
  const info = relationshipInfo(relationship);

  commit('Change political status', (r) => {
    const next: Partial<Territory> = {
      relationship,
      borderKind: info.border,
      // A sovereign belongs to nobody, so it neither sits under a parent nor
      // takes that parent's colour. Anything else joins its realm's family
      // unless it is the kind of thing that keeps its own colour.
      inheritParentColor: relationship !== 'sovereign' && !info.ownColor,
    };
    if (relationship === 'sovereign') {
      next.parentId = null;
      next.liegeId = null;
      // It had no colour of its own while it was inheriting one; keep the shade
      // it was actually drawn in rather than dropping back to the class default,
      // which would flip it to a colour the map has never shown.
      if (t.inheritParentColor && !t.styleOverrides.fillColor) {
        const shown = inheritedFill(project, t);
        if (shown) next.styleOverrides = { ...t.styleOverrides, fillColor: shown };
      }
    }
    r.update<Territory>('territories', id, next);
    syncRelationshipNote(r, { ...project, territories: { ...project.territories, [id]: { ...t, ...next } } }, id);
  });
}

/**
 * Create, update or remove the "Vassal of the M.C." line under a territory's
 * name (spec §6, §12, §26).
 *
 * It is a real label rather than a second line baked into the name, so it can be
 * dragged, restyled and deleted like anything else — and so the name above it
 * stays the name, which is what search, the data table and the exporter all read.
 */
function syncRelationshipNote(r: Recorder, project: MapProject, id: UUID): void {
  const t = project.territories[id];
  if (!t) return;
  const wanted = relationshipSubtitle(project, t);
  const existing = Object.values(project.labels).find(
    (l) => l.attachedToId === id && l.styleClassId === STYLE_IDS.textRelationship,
  );

  if (!wanted) {
    if (existing) r.remove('labels', existing.id);
    return;
  }
  if (existing) {
    r.update<MapLabel>('labels', existing.id, { text: wanted, name: wanted });
    return;
  }
  const name = t.labelId ? project.labels[t.labelId] : undefined;
  const label = makeLabel(project, name?.anchor ?? { type: 'Point', coordinates: interiorPoint(t.geometry) }, {
    kind: 'region',
    text: wanted,
    name: wanted,
    attachedToId: id,
    styleClassId: STYLE_IDS.textRelationship,
    // Sits under the name it annotates. Screen px, so it stays put at any zoom.
    offset: [name?.offset?.[0] ?? 0, (name?.offset?.[1] ?? 0) + 11],
    layerId: name?.layerId,
  });
  r.set('labels', label);
}

export function setLockedFor(ids: UUID[], locked: boolean): void {
  const project = getProject();
  commit(locked ? 'Lock' : 'Unlock', (r) => {
    for (const id of ids) {
      if (project.territories[id]) r.update<Territory>('territories', id, { locked });
      else if (project.settlements[id]) r.update<Settlement>('settlements', id, { locked });
      else if (project.labels[id]) r.update<MapLabel>('labels', id, { locked });
      else if (project.linearFeatures[id]) r.update('linearFeatures', id, { locked } as never);
    }
  });
}

export function setHiddenFor(ids: UUID[], hidden: boolean): void {
  const project = getProject();
  commit(hidden ? 'Hide' : 'Show', (r) => {
    for (const id of ids) {
      if (project.territories[id]) r.update<Territory>('territories', id, { hidden });
      else if (project.settlements[id]) r.update<Settlement>('settlements', id, { hidden });
      else if (project.labels[id]) r.update<MapLabel>('labels', id, { hidden });
      else if (project.linearFeatures[id]) r.update('linearFeatures', id, { hidden } as never);
    }
  });
}

// ---------------------------------------------------------------------------
// Layers (spec §19)
// ---------------------------------------------------------------------------

export function updateLayer(id: UUID, changes: Partial<MapLayer>, label = 'Edit layer'): void {
  commit(label, (r) => r.update<MapLayer>('layers', id, changes));
}

export function addLayer(kind: MapLayer['kind'], name: string, parentId: UUID | null = null): UUID {
  const project = getProject();
  const siblings = Object.values(project.layers).filter((l) => l.parentId === parentId);
  const layer = makeLayer({
    name,
    kind,
    parentId,
    order: siblings.length ? Math.max(...siblings.map((l) => l.order)) + 1 : 0,
  });
  commit('Add layer', (r) => r.set('layers', layer));
  return layer.id;
}

export function duplicateLayer(id: UUID): void {
  const project = getProject();
  const source = project.layers[id];
  if (!source) return;
  const siblings = Object.values(project.layers).filter((l) => l.parentId === source.parentId);
  const copy = makeLayer({
    ...source,
    id: newId(),
    name: `${source.name} copy`,
    order: Math.max(...siblings.map((l) => l.order)) + 1,
  });
  const idMap = new Map<UUID, UUID>([[id, copy.id]]);

  commit('Duplicate layer', (r) => {
    r.set('layers', copy);
    // Copy the features that live on it.
    for (const t of Object.values(project.territories)) {
      if (t.layerId !== id) continue;
      const nt = { ...t, id: newId(), layerId: copy.id, labelId: null };
      idMap.set(t.id, nt.id);
      r.set('territories', nt);
    }
    for (const s of Object.values(project.settlements)) {
      if (s.layerId !== id) continue;
      r.set('settlements', { ...s, id: newId(), layerId: copy.id, labelId: null });
    }
    for (const l of Object.values(project.labels)) {
      if (l.layerId !== id) continue;
      r.set('labels', {
        ...l,
        id: newId(),
        layerId: copy.id,
        attachedToId: l.attachedToId ? (idMap.get(l.attachedToId) ?? null) : null,
      });
    }
    for (const f of Object.values(project.linearFeatures)) {
      if (f.layerId !== id) continue;
      r.set('linearFeatures', { ...f, id: newId(), layerId: copy.id, labelId: null });
    }
  });
}

export function deleteLayer(id: UUID): void {
  const project = getProject();
  const layer = project.layers[id];
  if (!layer) return;

  // Collect the layer and all its descendants.
  const doomed = new Set<UUID>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of Object.values(project.layers)) {
      if (l.parentId && doomed.has(l.parentId) && !doomed.has(l.id)) {
        doomed.add(l.id);
        grew = true;
      }
    }
  }

  commit('Delete layer', (r) => {
    for (const t of Object.values(project.territories)) if (doomed.has(t.layerId)) r.remove('territories', t.id);
    for (const s of Object.values(project.settlements)) if (doomed.has(s.layerId)) r.remove('settlements', s.id);
    for (const l of Object.values(project.labels)) if (doomed.has(l.layerId)) r.remove('labels', l.id);
    for (const f of Object.values(project.linearFeatures)) if (doomed.has(f.layerId)) r.remove('linearFeatures', f.id);
    for (const lid of doomed) r.remove('layers', lid);
  });
}

/** Move a layer up or down within its siblings. */
export function reorderLayer(id: UUID, direction: -1 | 1): void {
  const project = getProject();
  const layer = project.layers[id];
  if (!layer) return;
  const siblings = Object.values(project.layers)
    .filter((l) => l.parentId === layer.parentId)
    .sort((a, b) => a.order - b.order);
  const index = siblings.findIndex((l) => l.id === id);
  const target = index + direction;
  if (target < 0 || target >= siblings.length) return;

  commit('Reorder layer', (r) => {
    const reordered = [...siblings];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    reordered.forEach((l, i) => {
      if (l.order !== i) r.update<MapLayer>('layers', l.id, { order: i });
    });
  });
}

/** Send the selected features to a different layer. */
export function moveSelectionToLayer(layerId: UUID): void {
  const project = getProject();
  const sel = useUIStore.getState().selection;
  commit('Move to layer', (r) => {
    for (const id of sel) {
      if (project.territories[id]) r.update<Territory>('territories', id, { layerId });
      else if (project.settlements[id]) r.update<Settlement>('settlements', id, { layerId });
      else if (project.labels[id]) r.update<MapLabel>('labels', id, { layerId });
      else if (project.linearFeatures[id]) r.update('linearFeatures', id, { layerId } as never);
    }
  });
}

// ---------------------------------------------------------------------------
// Style classes (spec §40)
// ---------------------------------------------------------------------------

type StyleBucket = keyof MapProject['styles'];

export function updateStyleClass(bucket: StyleBucket, id: UUID, style: unknown): void {
  const project = getProject();
  const existing = project.styles[bucket][id];
  if (!existing) return;
  commit(`Edit style "${existing.name}"`, (r) => {
    r.setDoc('styles', {
      ...project.styles,
      [bucket]: { ...project.styles[bucket], [id]: { ...existing, style } },
    } as MapProject['styles']);
  });
}

export function createStyleClass(bucket: StyleBucket, name: string, style: unknown): UUID {
  const project = getProject();
  const id = newId();
  commit('Create style class', (r) => {
    r.setDoc('styles', {
      ...project.styles,
      [bucket]: { ...project.styles[bucket], [id]: { id, name, builtin: false, style } },
    } as MapProject['styles']);
  });
  return id;
}

export function deleteStyleClass(bucket: StyleBucket, id: UUID): void {
  const project = getProject();
  const existing = project.styles[bucket][id];
  if (!existing || existing.builtin) {
    toast('Built-in styles cannot be deleted.', 'warn');
    return;
  }
  const rest = { ...project.styles[bucket] };
  delete rest[id];
  commit('Delete style class', (r) => {
    r.setDoc('styles', { ...project.styles, [bucket]: rest } as MapProject['styles']);
    // Re-point anything using it at the built-in default for that bucket.
    const fallback =
      bucket === 'territory' ? STYLE_IDS.territoryDefault
      : bucket === 'line' ? STYLE_IDS.lineProvincial
      : bucket === 'text' ? STYLE_IDS.textRegion
      : STYLE_IDS.symbolCity;
    for (const t of Object.values(project.territories)) {
      if (t.styleClassId === id) r.update<Territory>('territories', t.id, { styleClassId: fallback });
    }
    for (const s of Object.values(project.settlements)) {
      if (s.styleClassId === id) r.update<Settlement>('settlements', s.id, { styleClassId: fallback });
    }
    for (const l of Object.values(project.labels)) {
      if (l.styleClassId === id) r.update<MapLabel>('labels', l.id, { styleClassId: fallback });
    }
    for (const f of Object.values(project.linearFeatures)) {
      if (f.styleClassId === id) r.update('linearFeatures', f.id, { styleClassId: fallback } as never);
    }
  });
}

// ---------------------------------------------------------------------------
// Undo / redo passthroughs, for the toolbar and keyboard
// ---------------------------------------------------------------------------

export const undo = () => useProjectStore.getState().undo();
export const redo = () => useProjectStore.getState().redo();

/**
 * Turn a border drawn inside a state into a subdivision of it (spec §5, §7).
 *
 * This is the other half of the redraw tool, and the half the tool is usually
 * reached for: a stroke that runs along an existing outline moves that outline,
 * and a stroke drawn *inside* a state is a new border, so it makes a new
 * subdivision bounded by what was drawn.
 *
 * The stroke is closed to make a shape — a hand drawing a loop rarely lands
 * back on its own start — and passed through the clipper to resolve the
 * crossings freehand always leaves. It has to land inside a state; a loop drawn
 * on open ground is not a subdivision of anything, and is `stateFromStroke`'s
 * business instead.
 */
export function subdivisionFromStroke(stroke: LineString): UUID | null {
  const shape = closeStroke(stroke);
  if (!shape) return null;
  if (!enclosingTerritory(getProject(), shape)) return null;
  return addTerritory(shape);
}

/**
 * How far a stroke's ends may be apart, against its own length, to read as a
 * loop rather than a line.
 *
 * The third gesture of the redraw tool is the one with nothing to check it
 * against. A stroke along a border is anchored to that border; a loop inside a
 * state is anchored to the state; a loop on open ground is anchored to nothing,
 * so without a test of its own every failed attempt at the other two would
 * silently leave a country behind. Measuring the gap against the stroke's own
 * length rather than in degrees makes it the same gesture at every zoom: come
 * most of the way back round and it is an area, run off in a line and it is not.
 */
const STROKE_CLOSES = 0.35;

/**
 * Does a freehand stroke read as a loop?
 *
 * Exported for the tool that has to choose between the gestures before calling
 * any of them. Trying the reshape first and the loop-shaped commands on failure
 * reads well but is wrong, and the failure is silent: a loop drawn *near* a
 * border begins and ends "on" it as far as a generous freehand tolerance is
 * concerned, so the reshape succeeds and grafts the whole loop onto the
 * neighbour's outline as a lobe. Whether the stroke closes is what separates
 * the gestures — a redraw runs along a stretch, a loop comes back to its start
 * — so it has to be asked first, not used as a fallback.
 */
export function strokeCloses(stroke: LineString): boolean {
  const ring = stroke.coordinates;
  if (ring.length < 3) return false;
  let length = 0;
  for (let i = 1; i < ring.length; i++) {
    length += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  return length > 0 && Math.hypot(last[0] - first[0], last[1] - first[1]) <= length * STROKE_CLOSES;
}

/**
 * How much of a drawn area has to be unclaimed for it to mean a new state.
 *
 * Below this the stroke is lying across somebody's country and means something
 * else — a reshape that missed, most likely — and the tool says so rather than
 * carving a crescent out of the gap beside them.
 */
const MOSTLY_OPEN = 0.6;

/**
 * Turn a loop drawn on open ground into a new state (spec §5, §7).
 *
 * The third thing the redraw tool does, and the one that used to be a refusal:
 * drawing a border around unclaimed land is drawing a country, and being told
 * to go and find a state to draw inside first is not an answer when the point
 * was to put a state where there wasn't one.
 *
 * What comes back is the drawn area minus whatever was already claimed, so a
 * loop thrown generously around a gap gives the gap and not an overlap with the
 * neighbours it was drawn past. That is the same answer the paint bucket gives
 * for the same ground, which is the point — two tools, one idea of whose land
 * this is.
 */
export function stateFromStroke(stroke: LineString): UUID | null {
  const loop = closeStroke(stroke, true);
  if (!loop) return null;
  // A loop half over the sea means the land half: the coast finishes the
  // border. Trimmed before the openness test, so a bay inside the loop does
  // not count against the ground being claimed.
  const drawn = trimToLand(loop);
  if (!drawn || !(areaKm2(drawn) > 0)) return null;

  const project = getProject();
  if (enclosingTerritory(project, drawn)) return null;

  // Only the parts nobody holds. Cheap because a stroke is a local thing: only
  // the territories whose bounds reach it can be in the way.
  const box = bbox(drawn);
  let open: Poly | null = drawn;
  for (const t of Object.values(project.territories)) {
    if (t.hidden) continue;
    const other = bbox(t.geometry);
    if (other[0] > box[2] || other[2] < box[0] || other[1] > box[3] || other[3] < box[1]) continue;
    open = difference(open, t.geometry);
    if (!open) return null;
  }

  const area = areaKm2(open);
  if (!(area > 0) || area < areaKm2(drawn) * MOSTLY_OPEN) return null;
  // A freehand loop grazing two neighbours can leave crumbs between them; the
  // state is the ground that was drawn, not the shavings around it.
  const kept = dropSlivers(open, BARRIER_WIDTH_KM) ?? open;
  return addTerritory(kept, { parentId: null });
}

/** A freehand stroke as a polygon, closed up and cleaned of its own crossings. */
function closeStroke(stroke: LineString, requireLoop = false): Poly | null {
  const ring = [...stroke.coordinates];
  if (ring.length < 3) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];

  if (requireLoop) {
    let length = 0;
    for (let i = 1; i < ring.length; i++) {
      length += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
    }
    const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
    if (!(length > 0) || gap > length * STROKE_CLOSES) return null;
  }

  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  const shape = makeValid({ type: 'Polygon', coordinates: [ring] });
  return shape && areaKm2(shape) > 0 ? shape : null;
}

/**
 * Redraw a stretch of a territory's boundary by hand (spec §5, §6, §21).
 *
 * The stroke replaces the run of border it was drawn along. The territory on
 * the other side of that run follows the same edit, because a border belongs to
 * both of them and moving one side alone is how a map grows a seam — which is
 * the whole point of §6 and the reason this is a command rather than a nudge to
 * one polygon.
 *
 * Neighbours are found by asking which other territory's boundary lies along
 * the run that was replaced, so this is exact where a border really is shared
 * and does nothing where it merely passes nearby.
 */
export function reshapeTerritoryBoundary(
  territoryId: UUID,
  stroke: LineString,
  tolerance: number,
  /** Leave the complaining to the caller, which has another thing to try. */
  quiet = false,
): boolean {
  const project = getProject();
  const target = project.territories[territoryId];
  if (!target || target.locked) return false;

  const raw = reshapeBoundary(target.geometry, stroke, tolerance);
  if (!raw) {
    if (!quiet) toast('Draw over a border, starting and finishing on the same outline.', 'warn');
    return false;
  }
  // A border redrawn out over the water stops at the coast.
  const trimmed = trimToLand(raw.geometry);
  if (!trimmed) return false;
  const result = { ...raw, geometry: trimmed };

  // Whoever shares the stretch that was replaced has to move with it.
  const followers: { id: UUID; geometry: Poly }[] = [];
  for (const other of Object.values(project.territories)) {
    if (other.id === territoryId || other.locked || other.hidden) continue;
    if (!boundaryFollows(other.geometry, result.replaced, tolerance)) continue;
    const moved = reshapeBoundary(other.geometry, { type: 'LineString', coordinates: result.drawn }, tolerance);
    const kept = moved && trimToLand(moved.geometry);
    if (kept) followers.push({ id: other.id, geometry: kept });
  }

  commit('Redraw border', (r) => {
    r.update<Territory>('territories', territoryId, { geometry: result.geometry });
    syncAttachedLabel(r, territoryId, result.geometry);
    for (const f of followers) {
      r.update<Territory>('territories', f.id, { geometry: f.geometry });
      syncAttachedLabel(r, f.id, f.geometry);
    }
  });

  if (followers.length) {
    toast(`Border redrawn; ${followers.length} neighbour${followers.length === 1 ? '' : 's'} followed.`, 'success');
  }
  return true;
}

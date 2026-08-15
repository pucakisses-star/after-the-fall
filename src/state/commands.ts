/**
 * High-level editing commands.
 *
 * Everything the toolbar, context menu and keyboard shortcuts invoke lives here,
 * so a feature exists in exactly one place regardless of how many UI affordances
 * point at it.
 */

import type { LineString, Polygon, MultiPolygon, Position } from 'geojson';
import { newId } from '@/model/ids';
import { STYLE_IDS, politicalTypeInfo, relationshipInfo } from '@/model/defaults';
import { descendantsOf, relationshipSubtitle, wouldCreateCycle } from '@/model/hierarchy';
import { inheritedFill, resolveTerritoryStyle } from '@/model/resolveStyle';
import {
  areaKm2,
  difference,
  dissolve,
  explode,
  interiorPoint,
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
import { neighbourHoldingMostOf, regionAt } from '@/geo/floodFill';
import { recolor, type RecolorOptions } from '@/geo/palette';
import type { Recorder } from './history';
import type { MapLabel, MapLayer, MapProject, PoliticalRelationship, Settlement, Territory, UUID } from '@/model/types';
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

export function addTerritory(geometry: Polygon | MultiPolygon, init: Partial<Territory> = {}): UUID | null {
  const project = getProject();
  const cleaned = normalizePoly(geometry);
  if (!cleaned) {
    toast('That shape is not a valid polygon.', 'warn');
    return null;
  }
  const ui = useUIStore.getState();
  const territory = makeTerritory(project, cleaned, {
    politicalType: ui.draftPoliticalType,
    name: init.name ?? nextName(project, 'territories', 'New Territory'),
    ...init,
  });
  const label = makeLabel(project, { type: 'Point', coordinates: interiorPoint(cleaned) }, {
    kind: rankOf(territory) <= 2 ? 'country' : 'region',
    text: territory.name,
    attachedToId: territory.id,
  });

  commit('Draw territory', (r) => {
    r.set('territories', { ...territory, labelId: label.id });
    r.set('labels', label);
    // Inside the command, so redo restores this selection too.
    useUIStore.getState().selectAndReveal([territory.id]);
  });
  return territory.id;
}

export function addSettlement(coordinates: [number, number], init: Partial<Settlement> = {}): UUID {
  const project = getProject();
  const ui = useUIStore.getState();
  const settlement = makeSettlement(project, { type: 'Point', coordinates }, {
    type: ui.draftSettlementType,
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

  commit('Place settlement', (r) => {
    r.set('settlements', { ...settlement, labelId: label.id });
    r.set('labels', label);
    useUIStore.getState().selectAndReveal([settlement.id]);
  });
  return settlement.id;
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
  const cleaned = normalizePoly(geometry);
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

  const merged = union([target.geometry, region.geometry]);
  if (!merged) return { filled: false, message: 'Could not merge that ground into the realm.' };

  // What the old owner has left. Null means the fill took the whole of it, and a
  // territory with no ground is not a territory — it goes, with its name.
  const remainder = owner ? difference(owner.geometry, region.geometry) : null;

  const area = Math.round(areaKm2(region.geometry));
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
export function reshapeTerritoryBoundary(territoryId: UUID, stroke: LineString, tolerance: number): boolean {
  const project = getProject();
  const target = project.territories[territoryId];
  if (!target || target.locked) return false;

  const result = reshapeBoundary(target.geometry, stroke, tolerance);
  if (!result) {
    toast('Draw over a border, starting and finishing on the same outline.', 'warn');
    return false;
  }

  // Whoever shares the stretch that was replaced has to move with it.
  const followers: { id: UUID; geometry: Poly }[] = [];
  for (const other of Object.values(project.territories)) {
    if (other.id === territoryId || other.locked || other.hidden) continue;
    if (!boundaryFollows(other.geometry, result.replaced, tolerance)) continue;
    const moved = reshapeBoundary(other.geometry, { type: 'LineString', coordinates: result.drawn }, tolerance);
    if (moved) followers.push({ id: other.id, geometry: moved.geometry });
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

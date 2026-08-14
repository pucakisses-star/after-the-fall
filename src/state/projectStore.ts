/**
 * The document store. Holds the `MapProject` plus its undo stacks.
 *
 * Every write goes through `commit()`, which hands a `Recorder` to a mutator and
 * turns the result into an undoable command. Nothing else is allowed to touch the
 * project, which is what keeps undo (spec §36) complete and honest.
 */

import { create } from 'zustand';
import { newId } from '@/model/ids';
import { createProject, findLayerByKind, migrate } from '@/model/project';
import {
  MAX_HISTORY,
  Recorder,
  applyCommand,
  type Command,
} from './history';
import type {
  LinearFeature,
  MapLabel,
  MapLayer,
  MapProject,
  Settlement,
  Territory,
  UUID,
  SavedView,
} from '@/model/types';
import { useUIStore } from './uiStore';

export interface ProjectState {
  project: MapProject;
  past: Command[];
  future: Command[];
  /** Bumped on every document change; cheap signal for the renderer to resync. */
  revision: number;
  dirty: boolean;
  /** Dexie key of the saved project, if it has been saved at least once. */
  savedId: string | null;
  lastSavedAt: number | null;

  commit(label: string, mutate: (r: Recorder) => void): boolean;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undoLabel(): string | null;
  redoLabel(): string | null;

  /** Replace the whole document (open / new / demo). Clears history. */
  loadProject(project: MapProject, savedId?: string | null): void;
  /** View changes are not undoable — they would swamp the history stack. */
  setView(view: Partial<SavedView>): void;
  markSaved(savedId: string): void;
}

function nowMeta(p: MapProject): MapProject {
  return { ...p, meta: { ...p.meta, modifiedAt: new Date().toISOString() } };
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: createProject(),
  past: [],
  future: [],
  revision: 0,
  dirty: false,
  savedId: null,
  lastSavedAt: null,

  commit(label, mutate) {
    const state = get();
    const recorder = new Recorder(state.project);
    const selectionBefore = useUIStore.getState().selection;
    mutate(recorder);
    if (recorder.isEmpty) return false;

    const selectionAfter = useUIStore.getState().selection;
    const cmd: Command = {
      label,
      entity: recorder.entity,
      doc: recorder.doc,
      selectionBefore,
      selectionAfter,
    };

    const past = [...state.past, cmd];
    while (past.length > MAX_HISTORY) past.shift();

    set({
      project: nowMeta(recorder.result()),
      past,
      future: [],
      revision: state.revision + 1,
      dirty: true,
    });
    return true;
  },

  undo() {
    const state = get();
    const cmd = state.past[state.past.length - 1];
    if (!cmd) return;
    set({
      project: applyCommand(state.project, cmd, 'undo'),
      past: state.past.slice(0, -1),
      future: [cmd, ...state.future].slice(0, MAX_HISTORY),
      revision: state.revision + 1,
      dirty: true,
    });
    useUIStore.getState().setSelection(cmd.selectionBefore);
  },

  redo() {
    const state = get();
    const cmd = state.future[0];
    if (!cmd) return;
    set({
      project: applyCommand(state.project, cmd, 'redo'),
      past: [...state.past, cmd].slice(-MAX_HISTORY),
      future: state.future.slice(1),
      revision: state.revision + 1,
      dirty: true,
    });
    useUIStore.getState().setSelection(cmd.selectionAfter);
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
  undoLabel: () => get().past[get().past.length - 1]?.label ?? null,
  redoLabel: () => get().future[0]?.label ?? null,

  loadProject(project, savedId = null) {
    set({
      project: migrate(project),
      past: [],
      future: [],
      revision: get().revision + 1,
      dirty: false,
      savedId,
      lastSavedAt: savedId ? Date.now() : null,
    });
    useUIStore.getState().setSelection([]);
  },

  setView(view) {
    const state = get();
    set({ project: { ...state.project, view: { ...state.project.view, ...view } } });
  },

  markSaved(savedId) {
    set({ savedId, dirty: false, lastSavedAt: Date.now() });
  },
}));

// ---------------------------------------------------------------------------
// Convenience accessors — non-reactive, for use inside event handlers and tools.
// ---------------------------------------------------------------------------

export const getProject = (): MapProject => useProjectStore.getState().project;

export function commit(label: string, mutate: (r: Recorder) => void): boolean {
  return useProjectStore.getState().commit(label, mutate);
}

// ---------------------------------------------------------------------------
// Feature factories. Each fills in every required field so records are always
// complete and serialisable.
// ---------------------------------------------------------------------------

import { STYLE_IDS, politicalTypeInfo, settlementTypeInfo } from '@/model/defaults';
import type { LineString, MultiLineString, MultiPolygon, Point, Polygon } from 'geojson';

export function makeTerritory(
  project: MapProject,
  geometry: Polygon | MultiPolygon,
  init: Partial<Territory> = {},
): Territory {
  const layerId = init.layerId ?? findLayerByKind(project, 'territory')?.id ?? '';
  const politicalType = init.politicalType ?? 'kingdom';
  return {
    id: init.id ?? newId(),
    layerId,
    name: init.name ?? 'New Territory',
    shortName: init.shortName ?? '',
    politicalType,
    parentId: init.parentId ?? null,
    liegeId: init.liegeId ?? null,
    capitalId: init.capitalId ?? null,
    notes: init.notes ?? '',
    locked: init.locked ?? false,
    hidden: init.hidden ?? false,
    timeline: init.timeline ?? { start: null, end: null },
    geometry,
    styleClassId: init.styleClassId ?? STYLE_IDS.territoryDefault,
    styleOverrides: init.styleOverrides ?? {},
    inheritParentColor: init.inheritParentColor ?? false,
    borderKind: init.borderKind ?? politicalTypeInfo(politicalType)?.border ?? 'international',
    labelId: init.labelId ?? null,
  };
}

export function makeSettlement(
  project: MapProject,
  geometry: Point,
  init: Partial<Settlement> = {},
): Settlement {
  const type = init.type ?? 'city';
  return {
    id: init.id ?? newId(),
    layerId: init.layerId ?? findLayerByKind(project, 'settlement')?.id ?? '',
    name: init.name ?? 'New Settlement',
    notes: init.notes ?? '',
    locked: init.locked ?? false,
    hidden: init.hidden ?? false,
    timeline: init.timeline ?? { start: null, end: null },
    type,
    geometry,
    population: init.population ?? null,
    ownerId: init.ownerId ?? null,
    styleClassId: init.styleClassId ?? settlementTypeInfo(type).styleClassId,
    styleOverrides: init.styleOverrides ?? {},
    labelId: init.labelId ?? null,
  };
}

export function makeLabel(project: MapProject, anchor: Point, init: Partial<MapLabel> = {}): MapLabel {
  const kind = init.kind ?? 'free';
  const styleByKind: Record<string, UUID> = {
    country: STYLE_IDS.textCountry,
    region: STYLE_IDS.textRegion,
    city: STYLE_IDS.textCity,
    water: STYLE_IDS.textWater,
    ocean: STYLE_IDS.textOcean,
    river: STYLE_IDS.textRiver,
    mountain: STYLE_IDS.textRegion,
    free: STYLE_IDS.textRegion,
  };
  const layerByKind: Record<string, string> = {
    country: 'Country Labels',
    region: 'Region Labels',
    city: 'City Labels',
    water: 'Water Labels',
    ocean: 'Water Labels',
    river: 'Water Labels',
    mountain: 'Region Labels',
    free: 'Region Labels',
  };
  const named = Object.values(project.layers).find((l) => l.name === layerByKind[kind]);
  return {
    id: init.id ?? newId(),
    layerId: init.layerId ?? named?.id ?? findLayerByKind(project, 'label')?.id ?? '',
    name: init.name ?? init.text ?? 'Label',
    notes: init.notes ?? '',
    locked: init.locked ?? false,
    hidden: init.hidden ?? false,
    timeline: init.timeline ?? { start: null, end: null },
    kind,
    text: init.text ?? 'Label',
    anchor,
    attachedToId: init.attachedToId ?? null,
    manualPosition: init.manualPosition ?? false,
    offset: init.offset ?? [0, 0],
    rotation: init.rotation ?? 0,
    styleClassId: init.styleClassId ?? styleByKind[kind] ?? STYLE_IDS.textRegion,
    styleOverrides: init.styleOverrides ?? {},
    pathId: init.pathId ?? null,
    ignoreCollisions: init.ignoreCollisions ?? false,
    maxWidth: init.maxWidth ?? null,
  };
}

export function makeLinear(
  project: MapProject,
  geometry: LineString | MultiLineString,
  init: Partial<LinearFeature> = {},
): LinearFeature {
  const kind = init.kind ?? 'river';
  const styleByKind: Record<string, UUID> = {
    river: STYLE_IDS.lineRiver,
    'river-major': STYLE_IDS.lineRiverMajor,
    canal: STYLE_IDS.lineRiver,
    'road-major': STYLE_IDS.lineRoadMajor,
    'road-minor': STYLE_IDS.lineRoadMinor,
    'trade-route': STYLE_IDS.lineTradeRoute,
    'roman-road': STYLE_IDS.lineRoadMajor,
    trail: STYLE_IDS.lineRoadMinor,
    'sea-route': STYLE_IDS.lineTradeRoute,
    'label-path': STYLE_IDS.lineRiver,
  };
  const isRoad = kind.startsWith('road') || kind === 'trade-route' || kind === 'roman-road' || kind === 'trail' || kind === 'sea-route';
  return {
    id: init.id ?? newId(),
    layerId:
      init.layerId ?? findLayerByKind(project, isRoad ? 'road' : 'river')?.id ?? '',
    name: init.name ?? (isRoad ? 'New Road' : 'New River'),
    notes: init.notes ?? '',
    locked: init.locked ?? false,
    hidden: init.hidden ?? false,
    timeline: init.timeline ?? { start: null, end: null },
    kind,
    geometry,
    styleClassId: init.styleClassId ?? styleByKind[kind] ?? STYLE_IDS.lineRiver,
    styleOverrides: init.styleOverrides ?? {},
    flowsIntoId: init.flowsIntoId ?? null,
    smoothing: init.smoothing ?? 0,
    labelId: init.labelId ?? null,
  };
}

export function makeLayer(init: Partial<MapLayer> & Pick<MapLayer, 'name' | 'kind'>): MapLayer {
  return {
    id: init.id ?? newId(),
    name: init.name,
    kind: init.kind,
    parentId: init.parentId ?? null,
    visible: init.visible ?? true,
    locked: init.locked ?? false,
    opacity: init.opacity ?? 1,
    collapsed: init.collapsed ?? false,
    order: init.order ?? 0,
  };
}

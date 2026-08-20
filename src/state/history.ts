/**
 * Undo/redo (spec §36).
 *
 * Snapshotting the whole project per edit is simple but wasteful: a map with
 * 2,000 polygons is megabytes, and §36 asks for at least 100 history states.
 * Instead every edit records a *patch* — the before and after value of each
 * record it touched. Undo replays `before`, redo replays `after`. Cost is
 * proportional to what actually changed, so nudging one vertex costs one polygon,
 * not one map.
 *
 * All mutations funnel through `Recorder`, which builds the patch as a side effect
 * of the edit. There is deliberately no other way to write to the document.
 */

import type { MapProject, UUID } from '@/model/types';

/** Collections addressed by id. */
export type EntityKey = 'territories' | 'settlements' | 'linearFeatures' | 'labels' | 'layers';

/** Top-level document fields replaced wholesale. */
export type DocKey =
  | 'styles'
  | 'meta'
  | 'projection'
  | 'timeline'
  | 'basemap'
  | 'workingExtent'
  | 'politicalCohesion'
  | 'oceanColor'
  | 'landColor'
  | 'legend'
  | 'compass'
  | 'nameEverything'
  | 'dismissedPlaces';

export interface EntityPatch {
  key: EntityKey;
  id: UUID;
  /** `null` = did not exist. */
  before: unknown | null;
  after: unknown | null;
}

export interface DocPatch {
  key: DocKey;
  before: unknown;
  after: unknown;
}

export interface Command {
  label: string;
  entity: EntityPatch[];
  doc: DocPatch[];
  /** Selection at the time of the edit, restored on undo so the UI stays coherent. */
  selectionBefore: UUID[];
  selectionAfter: UUID[];
}

export const MAX_HISTORY = 200; // comfortably over the 100 the spec asks for

/**
 * Collects mutations and the patch describing them. Reads always see the latest
 * pending writes, so a command can read-modify-write several times.
 */
export class Recorder {
  readonly entity: EntityPatch[] = [];
  readonly doc: DocPatch[] = [];
  /** Working copy: collections are shallow-cloned lazily on first write. */
  private draft: MapProject;
  private cloned = new Set<string>();

  constructor(base: MapProject) {
    this.draft = { ...base };
  }

  /** Current state including everything written so far in this command. */
  get project(): MapProject {
    return this.draft;
  }

  private ensureCollection(key: EntityKey) {
    if (this.cloned.has(key)) return;
    this.cloned.add(key);
    this.draft = { ...this.draft, [key]: { ...(this.draft[key] as Record<string, unknown>) } };
  }

  /** Insert or replace a record. Pass the complete new object. */
  set<T extends { id: UUID }>(key: EntityKey, value: T): void {
    this.ensureCollection(key);
    const bucket = this.draft[key] as unknown as Record<UUID, unknown>;
    const before = bucket[value.id] ?? null;
    if (before === value) return;
    this.entity.push({ key, id: value.id, before, after: value });
    bucket[value.id] = value;
  }

  /** Patch an existing record. No-op when the record is missing. */
  update<T extends { id: UUID }>(key: EntityKey, id: UUID, changes: Partial<T>): void {
    const bucket = this.draft[key] as unknown as Record<UUID, T | undefined>;
    const current = bucket[id];
    if (!current) return;
    this.set(key, { ...current, ...changes });
  }

  remove(key: EntityKey, id: UUID): void {
    this.ensureCollection(key);
    const bucket = this.draft[key] as unknown as Record<UUID, unknown>;
    const before = bucket[id];
    if (before === undefined) return;
    this.entity.push({ key, id, before, after: null });
    delete bucket[id];
  }

  /** Replace a whole top-level document field. */
  setDoc<K extends DocKey>(key: K, value: MapProject[K]): void {
    const before = this.draft[key];
    if (before === value) return;
    this.doc.push({ key, before, after: value });
    this.draft = { ...this.draft, [key]: value };
  }

  get isEmpty(): boolean {
    return this.entity.length === 0 && this.doc.length === 0;
  }

  result(): MapProject {
    return this.draft;
  }
}

type Direction = 'undo' | 'redo';

/** Replay a command onto a project, in either direction. */
export function applyCommand(project: MapProject, cmd: Command, direction: Direction): MapProject {
  const next: MapProject = { ...project };
  const touched = new Set<EntityKey>();

  // Undo must run backwards so that two writes to the same record in one command
  // land on the original value.
  const entityPatches = direction === 'undo' ? [...cmd.entity].reverse() : cmd.entity;

  for (const p of entityPatches) {
    if (!touched.has(p.key)) {
      touched.add(p.key);
      (next as unknown as Record<string, unknown>)[p.key] = { ...(next[p.key] as Record<string, unknown>) };
    }
    const bucket = next[p.key] as unknown as Record<UUID, unknown>;
    const value = direction === 'undo' ? p.before : p.after;
    if (value === null) delete bucket[p.id];
    else bucket[p.id] = value;
  }

  const docPatches = direction === 'undo' ? [...cmd.doc].reverse() : cmd.doc;
  for (const p of docPatches) {
    (next as unknown as Record<string, unknown>)[p.key] = direction === 'undo' ? p.before : p.after;
  }

  return next;
}

/** Rough memory cost of a command, used to trim the stack. */
export function commandSize(cmd: Command): number {
  return cmd.entity.length + cmd.doc.length;
}

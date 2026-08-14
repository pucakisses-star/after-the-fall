/**
 * Local project storage (spec §50).
 *
 * IndexedDB via Dexie. Two tables:
 *   projects  — the saved documents
 *   snapshots — rolling autosave/recovery copies, capped per project
 *
 * Nothing leaves the machine; the app never needs a server (spec §1).
 */

import Dexie, { type Table } from 'dexie';
import type { MapProject } from '@/model/types';

export interface StoredProject {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  /** Serialised project. Stored as a plain object; Dexie structured-clones it. */
  data: MapProject;
  /** Rough size in bytes, shown in the open dialog. */
  bytes: number;
}

export interface Snapshot {
  key?: number;
  projectId: string;
  savedAt: number;
  reason: 'autosave' | 'pre-load' | 'manual';
  data: MapProject;
}

class AtfDatabase extends Dexie {
  projects!: Table<StoredProject, string>;
  snapshots!: Table<Snapshot, number>;

  constructor() {
    super('after-the-fall');
    this.version(1).stores({
      projects: 'id, title, updatedAt',
      snapshots: '++key, projectId, savedAt',
    });
  }
}

export const db = new AtfDatabase();

const MAX_SNAPSHOTS_PER_PROJECT = 12;

function estimateBytes(project: MapProject): number {
  try {
    return JSON.stringify(project).length;
  } catch {
    return 0;
  }
}

export async function saveProject(project: MapProject, id?: string): Promise<string> {
  const key = id ?? project.id;
  const now = Date.now();
  const existing = await db.projects.get(key);
  const record: StoredProject = {
    id: key,
    title: project.meta.title || 'Untitled Map',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    data: project,
    bytes: estimateBytes(project),
  };
  await db.projects.put(record);
  return key;
}

export async function listProjects(): Promise<StoredProject[]> {
  const all = await db.projects.orderBy('updatedAt').reverse().toArray();
  return all;
}

export async function loadProjectRecord(id: string): Promise<StoredProject | undefined> {
  return db.projects.get(id);
}

export async function deleteProject(id: string): Promise<void> {
  await db.transaction('rw', db.projects, db.snapshots, async () => {
    await db.projects.delete(id);
    await db.snapshots.where('projectId').equals(id).delete();
  });
}

export async function duplicateProject(id: string, newTitle: string): Promise<string | null> {
  const record = await db.projects.get(id);
  if (!record) return null;
  const copy: MapProject = {
    ...record.data,
    id: crypto.randomUUID ? crypto.randomUUID() : `${id}-copy-${Date.now()}`,
    meta: { ...record.data.meta, title: newTitle, createdAt: new Date().toISOString() },
  };
  return saveProject(copy, copy.id);
}

export async function writeSnapshot(project: MapProject, reason: Snapshot['reason']): Promise<void> {
  await db.snapshots.add({ projectId: project.id, savedAt: Date.now(), reason, data: project });
  // Trim the oldest so recovery history stays bounded.
  const keys = await db.snapshots.where('projectId').equals(project.id).sortBy('savedAt');
  if (keys.length > MAX_SNAPSHOTS_PER_PROJECT) {
    const doomed = keys.slice(0, keys.length - MAX_SNAPSHOTS_PER_PROJECT).map((s) => s.key!);
    await db.snapshots.bulkDelete(doomed);
  }
}

export async function listSnapshots(projectId: string): Promise<Snapshot[]> {
  const rows = await db.snapshots.where('projectId').equals(projectId).sortBy('savedAt');
  return rows.reverse();
}

/** Most recent snapshot across all projects — the crash-recovery candidate. */
export async function latestSnapshot(): Promise<Snapshot | undefined> {
  const rows = await db.snapshots.orderBy('savedAt').reverse().limit(1).toArray();
  return rows[0];
}

export async function isAvailable(): Promise<boolean> {
  try {
    await db.open();
    return true;
  } catch {
    return false;
  }
}

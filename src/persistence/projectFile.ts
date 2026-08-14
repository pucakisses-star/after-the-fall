/**
 * Project file I/O and autosave (spec §49, §50).
 *
 * The on-disk format is the `MapProject` object verbatim, wrapped in a small
 * envelope carrying the format name and app version. It is plain JSON: geometry
 * is GeoJSON, styles are objects, ids are strings. Nothing is a rendered pixel,
 * so a saved map is always fully editable (§49).
 */

import { migrate, SCHEMA_VERSION } from '@/model/project';
import type { MapProject } from '@/model/types';
import { useProjectStore } from '@/state/projectStore';
import { toast } from '@/state/uiStore';
import { saveProject, writeSnapshot } from './db';

export const FILE_EXTENSION = '.atfmap';
export const APP_VERSION = '0.1.0';

interface Envelope {
  format: 'after-the-fall/map';
  appVersion: string;
  schemaVersion: number;
  savedAt: string;
  project: MapProject;
}

export function serializeProject(project: MapProject): string {
  const envelope: Envelope = {
    format: 'after-the-fall/map',
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    project,
  };
  return JSON.stringify(envelope, null, 2);
}

/** Accepts both the envelope form and a bare project object. */
export function deserializeProject(text: string): MapProject {
  const parsed = JSON.parse(text) as Partial<Envelope> & Partial<MapProject>;
  if (parsed && typeof parsed === 'object' && 'project' in parsed && parsed.project) {
    return migrate(parsed.project);
  }
  return migrate(parsed as MapProject);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, filename: string, mime = 'application/json'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export function safeFilename(title: string, extension: string): string {
  const base = (title || 'map').replace(/[^\w\-. ]+/g, '').trim().replace(/\s+/g, '-') || 'map';
  return `${base}${extension}`;
}

export function exportProjectFile(project: MapProject): void {
  downloadText(serializeProject(project), safeFilename(project.meta.title, FILE_EXTENSION));
}

/** Read a `File` the user picked and load it into the store. */
export async function openProjectFile(file: File): Promise<void> {
  const text = await file.text();
  const project = deserializeProject(text);
  const current = useProjectStore.getState().project;
  // Keep a recovery point before replacing whatever is open.
  if (Object.keys(current.territories).length > 0) {
    await writeSnapshot(current, 'pre-load').catch(() => undefined);
  }
  useProjectStore.getState().loadProject(project, null);
}

// ---------------------------------------------------------------------------
// Autosave (spec §50)
// ---------------------------------------------------------------------------

let autosaveTimer: ReturnType<typeof setInterval> | null = null;
let snapshotCounter = 0;

export interface AutosaveOptions {
  /** How often to check for unsaved changes, in ms. */
  intervalMs?: number;
  /** Write a recovery snapshot every N autosaves. */
  snapshotEvery?: number;
}

export function startAutosave(opts: AutosaveOptions = {}): () => void {
  const interval = opts.intervalMs ?? 20_000;
  const snapshotEvery = opts.snapshotEvery ?? 3;

  const tick = async () => {
    const state = useProjectStore.getState();
    if (!state.dirty) return;
    // An empty document is not worth persisting.
    const p = state.project;
    const isEmpty =
      Object.keys(p.territories).length === 0 &&
      Object.keys(p.settlements).length === 0 &&
      Object.keys(p.labels).length === 0 &&
      Object.keys(p.linearFeatures).length === 0;
    if (isEmpty) return;

    try {
      const id = await saveProject(p, state.savedId ?? p.id);
      useProjectStore.getState().markSaved(id);
      if (++snapshotCounter % snapshotEvery === 0) await writeSnapshot(p, 'autosave');
    } catch (err) {
      // Storage can be full or blocked (private browsing). Say so once, quietly.
      console.warn('Autosave failed', err);
    }
  };

  autosaveTimer = setInterval(tick, interval);

  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (useProjectStore.getState().dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  return () => {
    if (autosaveTimer) clearInterval(autosaveTimer);
    autosaveTimer = null;
    window.removeEventListener('beforeunload', onBeforeUnload);
  };
}

/** Explicit save (Ctrl+S). */
export async function saveNow(): Promise<void> {
  const state = useProjectStore.getState();
  try {
    const id = await saveProject(state.project, state.savedId ?? state.project.id);
    state.markSaved(id);
    await writeSnapshot(state.project, 'manual').catch(() => undefined);
    toast(`Saved "${state.project.meta.title}".`, 'success');
  } catch (err) {
    toast(`Could not save: ${(err as Error).message}`, 'error');
  }
}

/** Save under a new title and id (Save As). */
export async function saveAs(title: string): Promise<void> {
  const state = useProjectStore.getState();
  const copy: MapProject = {
    ...state.project,
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
    meta: { ...state.project.meta, title },
  };
  try {
    const id = await saveProject(copy, copy.id);
    useProjectStore.getState().loadProject(copy, id);
    useProjectStore.getState().markSaved(id);
    toast(`Saved as "${title}".`, 'success');
  } catch (err) {
    toast(`Could not save: ${(err as Error).message}`, 'error');
  }
}

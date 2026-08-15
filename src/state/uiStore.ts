/**
 * UI state (spec §60: kept strictly out of the document).
 *
 * Nothing here is saved into a project file. Selection, the active tool, snap
 * settings and dialog visibility are session concerns.
 */

import { create } from 'zustand';
import type { UUID, PoliticalType, SettlementType, LinearKind, LabelKind } from '@/model/types';

export type ToolId =
  | 'select'
  | 'pan'
  | 'territory'
  | 'vertex'
  | 'reshape'
  | 'paint'
  | 'fill'
  | 'cut'
  | 'settlement'
  | 'label'
  | 'river'
  | 'road'
  | 'measure';

export type DialogId =
  | null
  | 'new-project'
  | 'open-project'
  | 'export-png'
  | 'export-svg'
  | 'import'
  | 'basemap'
  | 'palette'
  | 'topology'
  | 'styles'
  | 'data-table'
  | 'project-settings'
  | 'shortcuts';

export interface Toast {
  id: string;
  text: string;
  tone: 'info' | 'success' | 'warn' | 'error';
}

export interface UIState {
  tool: ToolId;
  /** Tool the app returns to when a transient tool (space-to-pan) ends. */
  previousTool: ToolId;
  selection: UUID[];
  hoverId: UUID | null;

  /** Defaults applied to the next drawn feature. */
  draftPoliticalType: PoliticalType;
  draftSettlementType: SettlementType;
  draftLinearKind: LinearKind;
  draftLabelKind: LabelKind;
  /** Territory the paint tool assigns subdivisions to (§56). */
  paintTargetId: UUID | null;
  /**
   * Whether the paint bucket stops at the lines the map is drawing (§57).
   *
   * On, because a fill that runs past the river you are looking at is a fill you
   * have to undo; off is there for filling a whole island in one click.
   */
  fillStopsAtLines: boolean;

  snapEnabled: boolean;
  /** Snap radius in screen pixels. */
  snapPixels: number;

  showBorders: boolean;
  showLabels: boolean;
  showGraticule: boolean;

  pointer: { lon: number; lat: number } | null;
  zoom: number;
  scaleText: string;

  dialog: DialogId;
  inspectorTab: 'object' | 'style' | 'project';
  layerPanelOpen: boolean;
  toasts: Toast[];
  /** Status line under the toolbar; used by long-running geometry commands. */
  status: string | null;

  setTool(t: ToolId): void;
  setSelection(ids: UUID[]): void;
  /** Select something and bring the Object tab forward — used after creating a feature. */
  selectAndReveal(ids: UUID[]): void;
  toggleSelection(id: UUID, additive: boolean): void;
  clearSelection(): void;
  setHover(id: UUID | null): void;
  setDialog(d: DialogId): void;
  setPointer(p: { lon: number; lat: number } | null): void;
  setViewInfo(zoom: number, scaleText: string): void;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: string): void;
  setStatus(s: string | null): void;
  patch(p: Partial<UIState>): void;
}

let toastSeq = 0;

export const useUIStore = create<UIState>((set, get) => ({
  tool: 'select',
  previousTool: 'select',
  selection: [],
  hoverId: null,

  draftPoliticalType: 'kingdom',
  draftSettlementType: 'city',
  draftLinearKind: 'river',
  draftLabelKind: 'region',
  paintTargetId: null,
  fillStopsAtLines: true,

  snapEnabled: true,
  snapPixels: 12,

  showBorders: true,
  showLabels: true,
  showGraticule: false,

  pointer: null,
  zoom: 5,
  scaleText: '',

  dialog: null,
  inspectorTab: 'object',
  layerPanelOpen: true,
  toasts: [],
  status: null,

  setTool(t) {
    const cur = get().tool;
    if (cur === t) return;
    // The paint tool's controls live in the Object tab, so bring it forward.
    set({ tool: t, previousTool: cur, ...(t === 'paint' ? { inspectorTab: 'object' as const } : {}) });
  },
  setSelection(ids) {
    set({ selection: ids });
  },
  selectAndReveal(ids) {
    set({ selection: ids, inspectorTab: 'object' });
  },
  toggleSelection(id, additive) {
    const cur = get().selection;
    if (!additive) {
      set({ selection: [id] });
      return;
    }
    set({ selection: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  clearSelection() {
    set({ selection: [] });
  },
  setHover(id) {
    if (get().hoverId === id) return;
    set({ hoverId: id });
  },
  setDialog(d) {
    set({ dialog: d });
  },
  setPointer(p) {
    set({ pointer: p });
  },
  setViewInfo(zoom, scaleText) {
    set({ zoom, scaleText });
  },
  toast(text, tone = 'info') {
    const id = `t${++toastSeq}`;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 8000 : 4000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setStatus(s) {
    set({ status: s });
  },
  patch(p) {
    set(p as Partial<UIState>);
  },
}));

export const toast = (text: string, tone?: Toast['tone']) => useUIStore.getState().toast(text, tone);

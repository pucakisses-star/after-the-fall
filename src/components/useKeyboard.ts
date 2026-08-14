/** Keyboard shortcuts (spec §53). */

import { useEffect } from 'react';
import { useUIStore, type ToolId } from '@/state/uiStore';
import { getProject } from '@/state/projectStore';
import { deleteSelection, duplicateSelection, redo, undo } from '@/state/commands';
import { saveNow } from '@/persistence/projectFile';
import type { MapController } from '@/render/MapController';

const TOOL_KEYS: Record<string, ToolId> = {
  v: 'select',
  h: 'pan',
  r: 'territory',
  a: 'vertex',
  b: 'paint',
  c: 'cut',
  s: 'settlement',
  t: 'label',
  w: 'river',
  d: 'road',
  m: 'measure',
};

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function useKeyboard(controller: MapController | null): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ui = useUIStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      // Shortcuts that must work even while a field has focus.
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
        return;
      }

      if (isTypingTarget(e.target)) return;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const project = getProject();
        ui.setSelection(Object.values(project.territories).filter((t) => !t.locked).map((t) => t.id));
        return;
      }
      if (mod) return; // leave every other modified key to the browser

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
        return;
      }

      if (e.key === 'Escape') {
        // Cancel whatever is in progress: close a dialog, else drop the selection,
        // else fall back to the select tool.
        if (ui.dialog) ui.setDialog(null);
        else if (ui.selection.length) ui.clearSelection();
        else ui.setTool('select');
        controller?.overlaySource.clear(true);
        return;
      }

      if (e.key === ' ' && ui.tool !== 'pan') {
        // Hold space for temporary pan, the standard creative-app convention.
        e.preventDefault();
        ui.setTool('pan');
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'f') {
        controller?.fitAll();
        return;
      }
      if (key === 'z') {
        controller?.zoomToSelection();
        return;
      }
      if (key === '+' || key === '=') {
        controller?.zoomBy(1);
        return;
      }
      if (key === '-' || key === '_') {
        controller?.zoomBy(-1);
        return;
      }

      const tool = TOOL_KEYS[key];
      if (tool) {
        e.preventDefault();
        ui.setTool(tool);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      if (isTypingTarget(e.target)) return;
      const ui = useUIStore.getState();
      if (ui.tool === 'pan' && ui.previousTool !== 'pan') ui.setTool(ui.previousTool);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [controller]);
}

/** Re-run the vertex tool when the selection changes, so it edits what is selected. */
export function useVertexToolRefresh(refresh: () => void): void {
  useEffect(() => {
    let lastSelection = useUIStore.getState().selection;
    return useUIStore.subscribe((state) => {
      if (state.tool !== 'vertex') {
        lastSelection = state.selection;
        return;
      }
      if (state.selection === lastSelection) return;
      lastSelection = state.selection;
      refresh();
    });
  }, [refresh]);
}

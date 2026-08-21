/** Right-click menu (spec §54). */

import { useEffect, useRef } from 'react';
import { useProjectStore, getProject } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import {
  clipboardSize,
  copySelection,
  createTerritoryFromSelection,
  deleteSelection,
  duplicateSelection,
  pasteClipboard,
  mergeSelected,
  setHiddenFor,
  setLockedFor,
  setParent,
  subtractSelected,
} from '@/state/commands';
import { useMapController } from './MapContext';

export function ContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const project = useProjectStore((s) => s.project);
  const selection = useUIStore((s) => s.selection);
  const setTool = useUIStore((s) => s.setTool);
  const controller = useMapController();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const territories = selection.filter((id) => project.territories[id]);
  const single = selection.length === 1 ? selection[0] : null;
  const territory = single ? project.territories[single] : null;
  const anyLocked = selection.some(
    (id) =>
      project.territories[id]?.locked ||
      project.settlements[id]?.locked ||
      project.labels[id]?.locked ||
      project.linearFeatures[id]?.locked,
  );
  const anyHidden = selection.some(
    (id) =>
      project.territories[id]?.hidden ||
      project.settlements[id]?.hidden ||
      project.labels[id]?.hidden ||
      project.linearFeatures[id]?.hidden,
  );

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  // Keep the menu inside the window.
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 340),
  };

  if (selection.length === 0) {
    return (
      <div className="context-menu" ref={ref} style={style}>
        <Item onClick={run(() => setTool('territory'))}>Draw territory</Item>
        <Item onClick={run(() => setTool('settlement'))}>Place settlement</Item>
        <Item onClick={run(() => setTool('label'))}>Add label</Item>
        <div className="context-menu__sep" />
        <Item onClick={run(() => controller?.fitAll())}>Fit map to contents</Item>
      </div>
    );
  }

  return (
    <div className="context-menu" ref={ref} style={style}>
      {territory && (
        <>
          <Item onClick={run(() => useUIStore.getState().patch({ inspectorTab: 'object' }))}>
            Edit territory
          </Item>
          <Item onClick={run(() => setTool('vertex'))} shortcut="A">
            Edit vertices
          </Item>
          <Item onClick={run(() => setTool('cut'))} shortcut="C">
            Split with a line
          </Item>
          <div className="context-menu__sep" />
        </>
      )}

      {territories.length >= 2 && (
        <>
          <Item onClick={run(mergeSelected)}>Merge territories</Item>
          <Item onClick={run(subtractSelected)}>Subtract from first</Item>
          <Item onClick={run(() => createTerritoryFromSelection())}>Create territory from selection</Item>
          <div className="context-menu__sep" />
        </>
      )}

      <Item onClick={run(copySelection)} disabled={selection.length === 0} shortcut="Ctrl+C">
        Copy
      </Item>
      <Item
        // The pointer was over the map to open this menu, so the position it
        // last reported is where "here" is.
        onClick={run(() => {
          const p = useUIStore.getState().pointer;
          pasteClipboard(p ? [p.lon, p.lat] : null);
        })}
        disabled={clipboardSize() === 0}
        shortcut="Ctrl+V"
      >
        Paste
      </Item>
      <Item onClick={run(duplicateSelection)} shortcut="Ctrl+D">
        Duplicate
      </Item>
      {territory && (
        <Item
          onClick={run(() => {
            const parents = Object.values(getProject().territories).filter((t) => t.id !== territory.id);
            if (parents.length === 0) return;
            const name = prompt(
              `Set the parent of "${territory.name}" to which state?\n\n${parents.map((p) => p.name).join('\n')}\n\n(leave blank to make it sovereign)`,
            );
            if (name === null) return;
            const match = parents.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
            setParent(territory.id, name.trim() ? (match?.id ?? null) : null);
          })}
        >
          Set parent…
        </Item>
      )}
      <div className="context-menu__sep" />

      <Item onClick={run(() => controller?.zoomToSelection())}>Zoom to selection</Item>
      <Item onClick={run(() => setLockedFor(selection, !anyLocked))}>{anyLocked ? 'Unlock' : 'Lock'}</Item>
      <Item onClick={run(() => setHiddenFor(selection, !anyHidden))}>{anyHidden ? 'Show' : 'Hide'}</Item>
      <div className="context-menu__sep" />
      <Item onClick={run(deleteSelection)} shortcut="Del">
        Delete
      </Item>
    </div>
  );
}

function Item({
  children,
  onClick,
  disabled,
  shortcut,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <button className="context-menu__item" onClick={onClick} disabled={disabled}>
      {children}
      {shortcut && <span className="context-menu__shortcut">{shortcut}</span>}
    </button>
  );
}

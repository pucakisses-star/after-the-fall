/** Top toolbar (spec §52). */

import { useRef } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { redo, undo } from '@/state/commands';
import { exportProjectFile, openProjectFile, saveNow } from '@/persistence/projectFile';
import { toast } from '@/state/uiStore';
import { SearchBox } from './SearchBox';
import { IconRedo, IconUndo } from './icons';

export function TopToolbar() {
  const dirty = useProjectStore((s) => s.dirty);
  const past = useProjectStore((s) => s.past);
  const future = useProjectStore((s) => s.future);
  const title = useProjectStore((s) => s.project.meta.title);
  const setDialog = useUIStore((s) => s.setDialog);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const undoLabel = past[past.length - 1]?.label;
  const redoLabel = future[0]?.label;

  return (
    <div className="toolbar">
      <span className="toolbar__brand">AFTER THE FALL</span>

      <button className="tbtn" onClick={() => setDialog('new-project')} title="Start a new map">
        New
      </button>
      <button className="tbtn" onClick={() => setDialog('open-project')} title="Open a saved map">
        Open
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".atfmap,.json"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            await openProjectFile(file);
            toast(`Opened "${file.name}".`, 'success');
          } catch (err) {
            toast(`Could not open that file: ${(err as Error).message}`, 'error');
          }
        }}
      />
      <button className="tbtn" onClick={() => fileRef.current?.click()} title="Open a .atfmap file from disk">
        Open file…
      </button>
      <button className="tbtn" onClick={() => void saveNow()} title="Save to this browser (Ctrl+S)">
        Save{dirty ? ' •' : ''}
      </button>
      <button
        className="tbtn"
        onClick={() => exportProjectFile(useProjectStore.getState().project)}
        title="Download the editable project file"
      >
        Save to file
      </button>

      <div className="toolbar__sep" />

      <button className="tbtn" disabled={past.length === 0} onClick={undo} title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'}>
        <IconUndo />
      </button>
      <button className="tbtn" disabled={future.length === 0} onClick={redo} title={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}>
        <IconRedo />
      </button>

      <div className="toolbar__sep" />

      <button className="tbtn" onClick={() => setDialog('import')} title="Import GeoJSON, TopoJSON, KML, GPX or CSV">
        Import
      </button>
      <button className="tbtn" onClick={() => setDialog('export-svg')} title="Export a vector map">
        Export SVG
      </button>
      <button className="tbtn" onClick={() => setDialog('export-png')} title="Export a raster map">
        Export PNG
      </button>

      <div className="toolbar__sep" />

      <button className="tbtn" onClick={() => setDialog('data-table')} title="Spreadsheet view of every feature">
        Data
      </button>

      <div className="toolbar__spacer" />

      <SearchBox />

      <span style={{ color: 'var(--text-faint)', padding: '0 10px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
      </span>

      <button className="tbtn" onClick={() => setDialog('shortcuts')} title="Keyboard shortcuts">
        ?
      </button>
    </div>
  );
}

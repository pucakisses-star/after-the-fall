import { useState } from 'react';
import { Dialog } from '../Dialog';
import { Field } from '../Inspector';
import { PROJECTION_PRESETS } from '@/geo/projections';
import { createProject } from '@/model/project';
import { buildDemoProject } from '@/demo/demoProject';
import { buildAfterTheEndProject } from '@/demo/afterTheEnd';
import { useProjectStore } from '@/state/projectStore';
import { toast, useUIStore } from '@/state/uiStore';
import { writeSnapshot } from '@/persistence/db';

/**
 * What a new map starts with.
 *
 * One starting geography, not a menu of them. The dialog used to offer six —
 * blank, two world variants, the Americas and two United States ones — which
 * asked for a decision before you had seen anything, and five of the answers
 * were a worse version of this one: a blank sheet you would immediately want a
 * coastline on, a world four fifths of which this map is not about, or a crop
 * so tight it cut off half the subject. None of it was capability: every
 * dataset here, and the US Census ones besides, is still one checkbox away in
 * the Project panel, and the crop is one button away under Map area.
 */
const START = {
  basemaps: [
    'world-land-10m',
    'world-lakes-10m',
    'world-rivers-10m',
    'world-roads-10m',
    'world-countries-10m',
    'world-places-10m',
  ],
  center: [-80, 10] as [number, number],
  zoom: 2.8,
  /**
   * WGS84 [w, s, e, n] the map is about: Cape Horn to the Arctic, Alaska to the
   * eastern seaboard, with enough water either side that the coasts are not
   * flush against the frame.
   *
   * Reference geography outside it is never loaded into the renderer and the
   * view cannot pan or zoom past it. Clear it under Project → Map area to go
   * global; nothing about it is baked into the document beyond this one field.
   */
  extent: [-172, -58, -28, 74] as [number, number, number, number],
};

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('Untitled Map');
  // The projection that suits the geography every new map now starts with:
  // equal-area and centred on the New World, so both continents sit on one
  // sheet at true relative size. The old default was a North America conic,
  // which is the right answer for the lower 48 and the wrong one for a map
  // that reaches Cape Horn.
  const [projectionId, setProjectionId] = useState('ATF:AMERICAS');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const current = useProjectStore.getState().project;
    if (Object.keys(current.territories).length > 0) {
      await writeSnapshot(current, 'pre-load').catch(() => undefined);
    }

    const preset = PROJECTION_PRESETS.find((p) => p.id === projectionId)!;
    const project = createProject({ title });
    project.projection = {
      id: preset.id,
      name: preset.name,
      proj4: preset.proj4,
      extent: preset.extent,
      units: preset.units,
    };
    project.basemap = START.basemaps.map((sourceId) => ({ sourceId, visible: true, opacity: 1 }));
    project.view = { center: START.center, zoom: START.zoom, rotation: 0 };
    project.workingExtent = START.extent;
    useProjectStore.getState().loadProject(project, null);
    onClose();
  };

  /** Both prebuilt maps come in through the same path; only the builder differs. */
  const loadPrebuilt = async (
    build: () => Promise<{ project: ReturnType<typeof createProject> }>,
    what: string,
  ) => {
    setBusy(true);
    try {
      const { project } = await build();
      useProjectStore.getState().loadProject(project, null);
      toast(`Loaded ${what}.`, 'success');
      onClose();
    } catch (err) {
      toast(`Could not build ${what}: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New map"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            onClick={() => void loadPrebuilt(buildAfterTheEndProject, 'the After the End map')}
            disabled={busy}
          >
            {busy ? 'Building…' : 'After the End map'}
          </button>
          <button
            className="btn"
            onClick={() => void loadPrebuilt(buildDemoProject, 'the demonstration map')}
            disabled={busy}
          >
            Demo map
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--accent" onClick={() => void create()} disabled={busy}>
            Create
          </button>
        </>
      }
    >
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Projection">
        <select className="select" value={projectionId} onChange={(e) => setProjectionId(e.target.value)}>
          {PROJECTION_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <p className="hint" style={{ marginBottom: 12 }}>
        {PROJECTION_PRESETS.find((p) => p.id === projectionId)?.description}
      </p>

      <h3 className="panel__section-title">Starting geography</h3>
      <div
        style={{
          padding: '8px 10px',
          border: '1px solid var(--line)',
          borderRadius: 3,
          background: 'var(--panel-3)',
        }}
      >
        <strong style={{ color: 'var(--text)' }}>The Americas</strong>
        <br />
        <span style={{ color: 'var(--text-faint)' }}>
          Coastlines, lakes, rivers, boundaries and cities at Natural Earth's finest published
          scale, cropped to the western hemisphere so nothing off-continent is drawn and the view
          stays on the subject.
        </span>
      </div>
      <p className="hint">
        Reference geography is a backdrop, not part of the document. Turn it into editable
        territories from the Project panel, where you can also switch on the US Census states and
        counties, or clear the crop under Map area to work on the whole world.
      </p>
    </Dialog>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['V', 'Select tool'],
    ['H', 'Pan tool'],
    ['R', 'Territory tool'],
    ['A', 'Edit vertices'],
    ['N', 'Redraw a border by hand'],
    ['B', 'Paint territory'],
    ['G', 'Fill unclaimed land'],
    ['C', 'Split with a line'],
    ['S', 'Settlement tool'],
    ['T', 'Label (text) tool'],
    ['W', 'River tool'],
    ['D', 'Road tool'],
    ['M', 'Measure'],
    ['Ctrl+Z', 'Undo'],
    ['Ctrl+Shift+Z', 'Redo'],
    ['Ctrl+S', 'Save'],
    ['Ctrl+D', 'Duplicate selection'],
    ['Ctrl+A', 'Select all territories'],
    ['Ctrl+F', 'Search'],
    ['Delete', 'Delete selection'],
    ['Esc', 'Cancel the current operation'],
    ['Shift+drag', 'Box-select'],
    ['Shift+click', 'Add to selection'],
    ['Alt+click', 'Remove a vertex (vertex tool)'],
    ['F', 'Fit map to contents'],
    ['Z', 'Zoom to selection'],
  ];
  const setDialog = useUIStore((s) => s.setDialog);

  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} footer={<button className="btn" onClick={() => setDialog(null)}>Close</button>}>
      <table className="table">
        <tbody>
          {rows.map(([key, what]) => (
            <tr key={key}>
              <td style={{ width: 130 }}>
                <span className="kbd">{key}</span>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

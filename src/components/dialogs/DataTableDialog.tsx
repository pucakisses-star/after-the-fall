/**
 * Spreadsheet view (spec §38). Editing a cell edits the map.
 */

import { useMemo, useState } from 'react';
import { Dialog } from '../Dialog';
import { commit, useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { setParent } from '@/state/commands';
import { POLITICAL_TYPES, SETTLEMENT_TYPES } from '@/model/defaults';
import { resolveTerritoryStyle } from '@/model/resolveStyle';
import { areaKm2 } from '@/geo/operations';
import { formatArea } from '@/geo/topology';
import { downloadText, safeFilename } from '@/persistence/projectFile';
import { useMapController } from '../MapContext';
import type { MapLabel, Settlement, Territory } from '@/model/types';

type Tab = 'territories' | 'settlements' | 'labels';

export function DataTableDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('territories');
  const project = useProjectStore((s) => s.project);

  return (
    <Dialog
      title="Data table"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => downloadCsv(tab)}>
            Export this table as CSV
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="tabs" style={{ marginBottom: 10 }}>
        {(['territories', 'settlements', 'labels'] as Tab[]).map((t) => (
          <button key={t} className={`tab${tab === t ? ' tab--active' : ''}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)} ({Object.keys(project[t]).length})
          </button>
        ))}
      </div>
      <div style={{ maxHeight: '58vh', overflow: 'auto' }}>
        {tab === 'territories' && <TerritoryTable />}
        {tab === 'settlements' && <SettlementTable />}
        {tab === 'labels' && <LabelTable />}
      </div>
    </Dialog>
  );
}

function TerritoryTable() {
  const project = useProjectStore((s) => s.project);
  const selection = useUIStore((s) => s.selection);
  const controller = useMapController();
  const rows = useMemo(
    () => Object.values(project.territories).sort((a, b) => a.name.localeCompare(b.name)),
    [project.territories],
  );

  const update = (id: string, changes: Partial<Territory>) =>
    commit('Edit in table', (r) => r.update<Territory>('territories', id, changes));

  if (rows.length === 0) return <div className="empty">No territories yet.</div>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 22 }} />
          <th>Name</th>
          <th style={{ width: 130 }}>Type</th>
          <th style={{ width: 140 }}>Parent</th>
          <th style={{ width: 130 }}>Capital</th>
          <th style={{ width: 66 }}>Colour</th>
          <th style={{ width: 68 }}>Start</th>
          <th style={{ width: 68 }}>End</th>
          <th style={{ width: 96 }}>Area</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr
            key={t.id}
            className={selection.includes(t.id) ? 'is-selected' : ''}
            onClick={() => useUIStore.getState().setSelection([t.id])}
            onDoubleClick={() => controller?.zoomToFeature(t.id)}
          >
            <td>
              <span className="tree-row__swatch" style={{ background: resolveTerritoryStyle(project, t).fillColor }} />
            </td>
            <td>
              <input value={t.name} onChange={(e) => update(t.id, { name: e.target.value })} />
            </td>
            <td>
              <select value={String(t.politicalType)} onChange={(e) => update(t.id, { politicalType: e.target.value })}>
                {POLITICAL_TYPES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
                {!POLITICAL_TYPES.some((p) => p.value === t.politicalType) && (
                  <option value={String(t.politicalType)}>{String(t.politicalType)}</option>
                )}
              </select>
            </td>
            <td>
              <select value={t.parentId ?? ''} onChange={(e) => setParent(t.id, e.target.value || null)}>
                <option value="">—</option>
                {rows
                  .filter((o) => o.id !== t.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
              </select>
            </td>
            <td>
              <select value={t.capitalId ?? ''} onChange={(e) => update(t.id, { capitalId: e.target.value || null })}>
                <option value="">—</option>
                {Object.values(project.settlements).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <input
                type="color"
                value={resolveTerritoryStyle(project, t).fillColor.slice(0, 7)}
                onChange={(e) =>
                  update(t.id, { styleOverrides: { ...t.styleOverrides, fillColor: e.target.value }, inheritParentColor: false })
                }
              />
            </td>
            <td>
              <input
                type="number"
                value={t.timeline.start ?? ''}
                onChange={(e) =>
                  update(t.id, {
                    timeline: { ...t.timeline, start: e.target.value === '' ? null : Number(e.target.value) },
                  })
                }
              />
            </td>
            <td>
              <input
                type="number"
                value={t.timeline.end ?? ''}
                onChange={(e) =>
                  update(t.id, {
                    timeline: { ...t.timeline, end: e.target.value === '' ? null : Number(e.target.value) },
                  })
                }
              />
            </td>
            <td className="mono">{formatArea(areaKm2(t.geometry))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SettlementTable() {
  const project = useProjectStore((s) => s.project);
  const selection = useUIStore((s) => s.selection);
  const controller = useMapController();
  const rows = useMemo(
    () => Object.values(project.settlements).sort((a, b) => a.name.localeCompare(b.name)),
    [project.settlements],
  );

  const update = (id: string, changes: Partial<Settlement>) =>
    commit('Edit in table', (r) => r.update<Settlement>('settlements', id, changes));

  if (rows.length === 0) return <div className="empty">No settlements yet.</div>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th style={{ width: 140 }}>Type</th>
          <th style={{ width: 150 }}>Owner</th>
          <th style={{ width: 100 }}>Population</th>
          <th style={{ width: 90 }}>Lat</th>
          <th style={{ width: 90 }}>Lon</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr
            key={s.id}
            className={selection.includes(s.id) ? 'is-selected' : ''}
            onClick={() => useUIStore.getState().setSelection([s.id])}
            onDoubleClick={() => controller?.zoomToFeature(s.id)}
          >
            <td>
              <input
                value={s.name}
                onChange={(e) => {
                  const name = e.target.value;
                  commit('Rename settlement', (r) => {
                    r.update<Settlement>('settlements', s.id, { name });
                    if (s.labelId) r.update<MapLabel>('labels', s.labelId, { text: name, name });
                  });
                }}
              />
            </td>
            <td>
              <select value={String(s.type)} onChange={(e) => update(s.id, { type: e.target.value })}>
                {SETTLEMENT_TYPES.map((x) => (
                  <option key={String(x.value)} value={String(x.value)}>
                    {x.label}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <select value={s.ownerId ?? ''} onChange={(e) => update(s.id, { ownerId: e.target.value || null })}>
                <option value="">—</option>
                {Object.values(project.territories).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <input
                type="number"
                value={s.population ?? ''}
                onChange={(e) => update(s.id, { population: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </td>
            <td className="mono">{s.geometry.coordinates[1].toFixed(4)}</td>
            <td className="mono">{s.geometry.coordinates[0].toFixed(4)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LabelTable() {
  const project = useProjectStore((s) => s.project);
  const selection = useUIStore((s) => s.selection);
  const controller = useMapController();
  const rows = useMemo(
    () => Object.values(project.labels).sort((a, b) => a.text.localeCompare(b.text)),
    [project.labels],
  );

  const update = (id: string, changes: Partial<MapLabel>) =>
    commit('Edit in table', (r) => r.update<MapLabel>('labels', id, changes));

  if (rows.length === 0) return <div className="empty">No labels yet.</div>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Text</th>
          <th style={{ width: 110 }}>Kind</th>
          <th style={{ width: 150 }}>Style class</th>
          <th style={{ width: 80 }}>Rotation</th>
          <th style={{ width: 90 }}>Manual</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => (
          <tr
            key={l.id}
            className={selection.includes(l.id) ? 'is-selected' : ''}
            onClick={() => useUIStore.getState().setSelection([l.id])}
            onDoubleClick={() => controller?.zoomToFeature(l.id)}
          >
            <td>
              <input value={l.text} onChange={(e) => update(l.id, { text: e.target.value })} />
            </td>
            <td>
              <select value={l.kind} onChange={(e) => update(l.id, { kind: e.target.value as MapLabel['kind'] })}>
                {['country', 'region', 'city', 'water', 'ocean', 'river', 'mountain', 'free'].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <select value={l.styleClassId} onChange={(e) => update(l.id, { styleClassId: e.target.value })}>
                {Object.values(project.styles.text).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <input
                type="number"
                value={l.rotation}
                onChange={(e) => update(l.id, { rotation: Number(e.target.value) })}
              />
            </td>
            <td>
              <input
                type="checkbox"
                checked={l.manualPosition}
                onChange={(e) => update(l.id, { manualPosition: e.target.checked })}
                style={{ width: 'auto' }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function downloadCsv(tab: Tab): void {
  const project = useProjectStore.getState().project;
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  let header: string[];
  let rows: unknown[][];

  if (tab === 'territories') {
    header = ['Name', 'Type', 'Parent', 'Capital', 'Colour', 'Start', 'End', 'Area km2', 'Notes'];
    rows = Object.values(project.territories).map((t) => [
      t.name,
      t.politicalType,
      t.parentId ? (project.territories[t.parentId]?.name ?? '') : '',
      t.capitalId ? (project.settlements[t.capitalId]?.name ?? '') : '',
      resolveTerritoryStyle(project, t).fillColor,
      t.timeline.start,
      t.timeline.end,
      areaKm2(t.geometry).toFixed(2),
      t.notes,
    ]);
  } else if (tab === 'settlements') {
    header = ['Name', 'Type', 'Owner', 'Population', 'Latitude', 'Longitude'];
    rows = Object.values(project.settlements).map((s) => [
      s.name,
      s.type,
      s.ownerId ? (project.territories[s.ownerId]?.name ?? '') : '',
      s.population,
      s.geometry.coordinates[1],
      s.geometry.coordinates[0],
    ]);
  } else {
    header = ['Text', 'Kind', 'Rotation', 'Manual', 'Latitude', 'Longitude'];
    rows = Object.values(project.labels).map((l) => [
      l.text,
      l.kind,
      l.rotation,
      l.manualPosition,
      l.anchor.coordinates[1],
      l.anchor.coordinates[0],
    ]);
  }

  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  downloadText(csv, safeFilename(`${project.meta.title}-${tab}`, '.csv'), 'text/csv');
}

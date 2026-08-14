/** Import dialog (spec §47). */

import { useRef, useState } from 'react';
import { Dialog } from '../Dialog';
import { Field } from '../Inspector';
import { POLITICAL_TYPES, BORDER_HIERARCHY } from '@/model/defaults';
import { importFileWithFeedback } from '@/io/importers';
import { useProjectStore } from '@/state/projectStore';
import type { BorderStyleKind, PoliticalType } from '@/model/types';

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((s) => s.project);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [politicalType, setPoliticalType] = useState<PoliticalType>('province');
  const [borderKind, setBorderKind] = useState<BorderStyleKind>('provincial');
  const [parentId, setParentId] = useState<string>('');
  const [createLabels, setCreateLabels] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      title="Import"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn--accent" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Importing…' : 'Choose a file…'}
          </button>
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept=".geojson,.json,.topojson,.kml,.gpx,.csv,.tsv"
        multiple
        style={{ display: 'none' }}
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (!files.length) return;
          setBusy(true);
          for (const file of files) {
            await importFileWithFeedback(file, {
              politicalType,
              borderKind,
              parentId: parentId || null,
              createLabels,
            });
          }
          setBusy(false);
          onClose();
        }}
      />

      <p className="hint" style={{ marginTop: 0 }}>
        Reads <strong>GeoJSON</strong>, <strong>TopoJSON</strong>, <strong>KML</strong>,{' '}
        <strong>GPX</strong> and <strong>CSV</strong>. Polygons become territories, points become
        settlements, lines become rivers or roads. Names are read from a{' '}
        <span className="mono">name</span>, <span className="mono">NAME</span> or{' '}
        <span className="mono">admin</span> property.
      </p>
      <p className="hint">
        CSV settlements need latitude and longitude columns;{' '}
        <span className="mono">Name, Latitude, Longitude, Type, Population</span> headers are
        recognised automatically.
      </p>

      <h3 className="panel__section-title" style={{ marginTop: 14 }}>
        Defaults for imported polygons
      </h3>
      <Field label="Political type">
        <select className="select" value={String(politicalType)} onChange={(e) => setPoliticalType(e.target.value)}>
          {POLITICAL_TYPES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Border weight">
        <select className="select" value={String(borderKind)} onChange={(e) => setBorderKind(e.target.value)}>
          {BORDER_HIERARCHY.map((b) => (
            <option key={String(b.kind)} value={String(b.kind)}>
              {b.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Parent state">
        <select className="select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">— none —</option>
          {Object.values(project.territories).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={createLabels} onChange={(e) => setCreateLabels(e.target.checked)} />
        Create a label for each imported feature
      </label>
    </Dialog>
  );
}

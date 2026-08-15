/** Palette generator (spec §22) and cleanup commands (spec §58). */

import { useState } from 'react';
import { Dialog } from '../Dialog';
import { Field, Slider } from '../Inspector';
import { PALETTES, type PaletteMode } from '@/model/defaults';
import { paletteFor } from '@/geo/palette';
import { recolorPoliticalMap, removeTinyPolygons } from '@/state/commands';
import { useProjectStore } from '@/state/projectStore';

const MODES: { value: PaletteMode; label: string }[] = [
  { value: 'historical-atlas', label: 'Historical atlas' },
  { value: 'after-the-event', label: 'After the End plates' },
  { value: 'imperial-patchwork', label: 'Imperial patchwork' },
  { value: 'jewel', label: 'Jewel' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'pastel', label: 'Pastel' },
  { value: 'muted', label: 'Muted' },
  { value: 'vibrant', label: 'Vibrant' },
  { value: 'monochromatic', label: 'Monochromatic' },
  { value: 'random', label: 'Random' },
];

export function PaletteDialog({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((s) => s.project);
  const [mode, setMode] = useState<PaletteMode>('historical-atlas');
  const [baseHue, setBaseHue] = useState(32);
  const [seed, setSeed] = useState(1);

  const count = Object.values(project.territories).filter((t) => !t.inheritParentColor).length;
  const lockedCount = Object.values(project.territories).filter((t) => t.locked).length;
  const preview = paletteFor(mode, Math.max(count, 12), { mode, baseHue, seed });

  return (
    <Dialog
      title="Recolour political map"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn--accent"
            onClick={() => {
              recolorPoliticalMap({ mode, baseHue, seed });
              setSeed((s) => s + 1);
            }}
          >
            Recolour Political Map
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Colours are assigned by graph colouring: territories that share a border are pushed apart in
        colour space, so no two neighbours end up looking alike. Territories that inherit their
        parent's colour follow automatically, and locked territories keep what they have.
      </p>

      <Field label="Palette">
        <select className="select" value={mode} onChange={(e) => setMode(e.target.value as PaletteMode)}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>

      {mode === 'monochromatic' && (
        <Field label="Base hue">
          <Slider value={baseHue} min={0} max={359} step={1} onChange={setBaseHue} suffix="°" />
        </Field>
      )}

      <h3 className="panel__section-title" style={{ marginTop: 12 }}>
        Preview
      </h3>
      <div className="swatches" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(30px, 1fr))' }}>
        {preview.slice(0, 24).map((c, i) => (
          <div key={`${c}-${i}`} className="swatch" style={{ background: c }} title={c} />
        ))}
      </div>

      <p className="hint">
        {count} sovereign territories will be recoloured
        {lockedCount ? `; ${lockedCount} locked territories will be left alone` : ''}.
        {mode === 'random' && ' Press the button again for a different arrangement.'}
      </p>

      <h3 className="panel__section-title" style={{ marginTop: 16 }}>
        Built-in palettes
      </h3>
      {(Object.keys(PALETTES) as (keyof typeof PALETTES)[]).map((key) => (
        <div key={key} style={{ marginBottom: 7 }}>
          <div style={{ color: 'var(--text-faint)', fontSize: 10, marginBottom: 3 }}>{key}</div>
          <div style={{ display: 'flex', gap: 2 }}>
            {PALETTES[key].map((c) => (
              <div key={c} style={{ flex: 1, height: 15, background: c, borderRadius: 2 }} title={c} />
            ))}
          </div>
        </div>
      ))}

      <h3 className="panel__section-title" style={{ marginTop: 16 }}>
        Cleanup
      </h3>
      <button
        className="btn btn--full"
        onClick={() => {
          const raw = prompt('Remove polygon parts smaller than how many km²?', '5');
          if (raw === null) return;
          const km2 = Number(raw);
          if (Number.isFinite(km2) && km2 > 0) removeTinyPolygons(km2);
        }}
      >
        Remove tiny polygons…
      </button>
      <p className="hint">
        Drops stray fragments from multi-part territories — usually leftovers from a boolean
        operation. Undoable like any other edit.
      </p>
    </Dialog>
  );
}

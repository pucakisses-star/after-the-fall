/**
 * Style class editor (spec §40).
 *
 * Editing a class here changes every object that uses it. Objects keep their own
 * sparse overrides, which the Object tab edits.
 */

import { useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { createStyleClass, deleteStyleClass, updateStyleClass } from '@/state/commands';
import { FONT_STACKS, defaultLineStyle, defaultTerritoryStyle, defaultTextStyle } from '@/model/defaults';
import { Field, Section, Slider } from './Inspector';
import type { DashKind, LineStyle, TerritoryStyle, TextStyle } from '@/model/types';

type Bucket = 'territory' | 'line' | 'text' | 'symbol';

const BUCKET_LABELS: Record<Bucket, string> = {
  territory: 'Territory fills',
  line: 'Lines & borders',
  text: 'Text',
  symbol: 'Symbols',
};

export function StylePanel() {
  const project = useProjectStore((s) => s.project);
  const [bucket, setBucket] = useState<Bucket>('line');
  const [selected, setSelected] = useState<string | null>(null);

  const classes = Object.values(project.styles[bucket]);
  const active = selected && project.styles[bucket][selected] ? project.styles[bucket][selected] : null;

  return (
    <>
      <Section title="Style classes">
        <Field label="Category">
          <select
            className="select"
            value={bucket}
            onChange={(e) => {
              setBucket(e.target.value as Bucket);
              setSelected(null);
            }}
          >
            {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
              <option key={b} value={b}>
                {BUCKET_LABELS[b]}
              </option>
            ))}
          </select>
        </Field>
        <div style={{ maxHeight: 190, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 3 }}>
          {classes.map((c) => (
            <div
              key={c.id}
              className={`tree-row${selected === c.id ? ' tree-row--selected' : ''}`}
              style={{ paddingLeft: 7 }}
              onClick={() => setSelected(c.id)}
            >
              <StylePreview bucket={bucket} style={c.style as never} />
              <span className="tree-row__name">{c.name}</span>
              {!c.builtin && <span className="tree-row__badge">custom</span>}
            </div>
          ))}
        </div>
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button
            className="btn"
            onClick={() => {
              const name = prompt('Name for the new style class');
              if (!name) return;
              const base =
                bucket === 'territory' ? defaultTerritoryStyle()
                : bucket === 'line' ? defaultLineStyle()
                : bucket === 'text' ? defaultTextStyle()
                : { shape: 'circle', size: 7, fillColor: '#fdfaf2', strokeColor: '#2b2318', strokeWidth: 1.1, opacity: 1, customPath: null };
              const id = createStyleClass(bucket, name, active ? structuredClone(active.style) : base);
              setSelected(id);
            }}
          >
            New
          </button>
          <button
            className="btn btn--danger"
            disabled={!active || active.builtin}
            onClick={() => {
              if (!active) return;
              deleteStyleClass(bucket, active.id);
              setSelected(null);
            }}
          >
            Delete
          </button>
        </div>
      </Section>

      {active && bucket === 'line' && (
        <LineStyleEditor
          value={active.style as LineStyle}
          onChange={(style) => updateStyleClass('line', active.id, style)}
        />
      )}
      {active && bucket === 'text' && (
        <TextStyleEditor
          value={active.style as TextStyle}
          onChange={(style) => updateStyleClass('text', active.id, style)}
        />
      )}
      {active && bucket === 'territory' && (
        <TerritoryStyleEditor
          value={active.style as TerritoryStyle}
          onChange={(style) => updateStyleClass('territory', active.id, style)}
        />
      )}
      {active && bucket === 'symbol' && (
        <Section title="Symbol">
          <p className="hint" style={{ marginTop: 0 }}>
            Symbol shapes and sizes are edited per settlement in the Object tab; this list controls
            which class each settlement type uses by default.
          </p>
        </Section>
      )}
      {!active && (
        <div className="empty">Select a style class to edit it. Changes apply everywhere it is used.</div>
      )}
    </>
  );
}

function StylePreview({ bucket, style }: { bucket: Bucket; style: Record<string, unknown> }) {
  if (bucket === 'line') {
    const s = style as unknown as LineStyle;
    return (
      <span style={{ width: 26, flex: 'none', display: 'grid', placeItems: 'center' }}>
        <span
          style={{
            display: 'block',
            width: 22,
            height: Math.max(1, Math.min(5, s.width)),
            background: s.color,
            opacity: s.opacity,
            borderRadius: 1,
          }}
        />
      </span>
    );
  }
  if (bucket === 'territory') {
    const s = style as unknown as TerritoryStyle;
    return <span className="tree-row__swatch" style={{ background: s.fillColor }} />;
  }
  if (bucket === 'text') {
    const s = style as unknown as TextStyle;
    return (
      <span style={{ width: 26, flex: 'none', textAlign: 'center', color: s.color, fontSize: 11 }}>Aa</span>
    );
  }
  return <span style={{ width: 26, flex: 'none' }} />;
}

const DASH_KINDS: DashKind[] = ['solid', 'dashed', 'dotted', 'dash-dot', 'double', 'alternating'];

function LineStyleEditor({ value, onChange }: { value: LineStyle; onChange: (v: LineStyle) => void }) {
  return (
    <Section title="Line">
      <Field label="Colour">
        <input
          className="color-input"
          type="color"
          value={value.color.slice(0, 7)}
          onChange={(e) => onChange({ ...value, color: e.target.value })}
        />
      </Field>
      <Field label="Width">
        <Slider value={value.width} min={0} max={12} step={0.1} onChange={(v) => onChange({ ...value, width: v })} suffix="px" />
      </Field>
      <Field label="Opacity">
        <Slider value={value.opacity} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...value, opacity: v })} />
      </Field>
      <Field label="Dash">
        <select className="select" value={value.dash} onChange={(e) => onChange({ ...value, dash: e.target.value as DashKind })}>
          {DASH_KINDS.map((d) => (
            <option key={d} value={d}>
              {d.replace('-', ' ')}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Casing">
        <input
          className="color-input"
          type="color"
          value={(value.casingColor ?? '#ffffff').slice(0, 7)}
          onChange={(e) => onChange({ ...value, casingColor: e.target.value })}
        />
      </Field>
      <Field label="Casing width">
        <Slider
          value={value.casingWidth}
          min={0}
          max={6}
          step={0.1}
          onChange={(v) => onChange({ ...value, casingWidth: v, casingColor: value.casingColor ?? '#ffffff' })}
        />
      </Field>
    </Section>
  );
}

function TextStyleEditor({ value, onChange }: { value: TextStyle; onChange: (v: TextStyle) => void }) {
  return (
    <Section title="Text">
      <Field label="Font">
        <select className="select" value={value.fontFamily} onChange={(e) => onChange({ ...value, fontFamily: e.target.value })}>
          {FONT_STACKS.map((f) => (
            <option key={f.label} value={f.value}>
              {f.label}
            </option>
          ))}
          {!FONT_STACKS.some((f) => f.value === value.fontFamily) && <option value={value.fontFamily}>Custom</option>}
        </select>
      </Field>
      <Field label="Size">
        <Slider value={value.fontSize} min={5} max={80} step={0.5} onChange={(v) => onChange({ ...value, fontSize: v })} suffix="px" />
      </Field>
      <Field label="Tracking">
        <Slider value={value.tracking} min={-3} max={40} step={0.5} onChange={(v) => onChange({ ...value, tracking: v })} suffix="px" />
      </Field>
      <Field label="Weight">
        <select className="select" value={value.fontWeight} onChange={(e) => onChange({ ...value, fontWeight: Number(e.target.value) })}>
          {[300, 400, 500, 600, 700, 800].map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
      </Field>
      <Field label="Case">
        <select
          className="select"
          value={value.transform}
          onChange={(e) => onChange({ ...value, transform: e.target.value as TextStyle['transform'] })}
        >
          <option value="none">As typed</option>
          <option value="uppercase">UPPERCASE</option>
          <option value="lowercase">lowercase</option>
          <option value="capitalize">Capitalise</option>
        </select>
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={value.italic} onChange={(e) => onChange({ ...value, italic: e.target.checked })} />
        Italic
      </label>
      <Field label="Colour">
        <input className="color-input" type="color" value={value.color.slice(0, 7)} onChange={(e) => onChange({ ...value, color: e.target.value })} />
      </Field>
      <Field label="Halo">
        <input
          className="color-input"
          type="color"
          value={(value.haloColor ?? '#ffffff').slice(0, 7)}
          onChange={(e) => onChange({ ...value, haloColor: e.target.value })}
        />
      </Field>
      <Field label="Halo width">
        <Slider value={value.haloWidth} min={0} max={9} step={0.25} onChange={(v) => onChange({ ...value, haloWidth: v })} />
      </Field>
    </Section>
  );
}

function TerritoryStyleEditor({ value, onChange }: { value: TerritoryStyle; onChange: (v: TerritoryStyle) => void }) {
  return (
    <Section title="Territory fill">
      <Field label="Fill">
        <input className="color-input" type="color" value={value.fillColor.slice(0, 7)} onChange={(e) => onChange({ ...value, fillColor: e.target.value })} />
      </Field>
      <Field label="Opacity">
        <Slider value={value.fillOpacity} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...value, fillOpacity: v })} />
      </Field>
      <Field label="Outline">
        <input
          className="color-input"
          type="color"
          value={value.outline.color.slice(0, 7)}
          onChange={(e) => onChange({ ...value, outline: { ...value.outline, color: e.target.value } })}
        />
      </Field>
      <Field label="Outline w.">
        <Slider
          value={value.outline.width}
          min={0}
          max={6}
          step={0.1}
          onChange={(v) => onChange({ ...value, outline: { ...value.outline, width: v } })}
        />
      </Field>
    </Section>
  );
}

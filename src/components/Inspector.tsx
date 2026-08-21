/**
 * Object inspector (spec §20, §39).
 *
 * Every control here writes through the command layer, so every change is
 * undoable and every change updates the map immediately.
 */

import { useEffect, useMemo, useState } from 'react';
import { useProjectStore, commit, getProject } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import {
  bulkUpdate,
  deleteSelection,
  duplicateSelection,
  mergeSelected,
  createTerritoryFromSelection,
  setParent,
  setRelationship,
  setTerritoryFill,
  setHiddenFor,
  setLockedFor,
  subtractSelected,
  simplifySelection,
  smoothSelection,
} from '@/state/commands';
import {
  BORDER_HIERARCHY,
  FONT_STACKS,
  PALETTES,
  POLITICAL_RELATIONSHIPS,
  POLITICAL_TYPES,
  SETTLEMENT_TYPES,
  STYLE_IDS,
  defaultFixedSize,
} from '@/model/defaults';
import { resolveTerritoryStyle, resolveTextStyle, resolveSymbolStyle } from '@/model/resolveStyle';
import { relationshipSubtitle } from '@/model/hierarchy';
import { areaKm2 } from '@/geo/operations';
import { formatArea } from '@/geo/topology';
import { useMapController } from './MapContext';
import type { MapController } from '@/render/MapController';
import { CapitalField } from './CapitalField';
import { ProjectPanel } from './ProjectPanel';
import { StylePanel } from './StylePanel';
import { SYMBOL_SHAPES } from '@/render/symbols';
import { pinnedText } from '@/render/labelFit';
import { barrierSources } from '@/geo/barriers';
import type {
  HatchKind,
  LinearFeature,
  MapLabel,
  MapProject,
  Settlement,
  SymbolShape,
  Territory,
  TerritoryStyle,
  TextStyle,
} from '@/model/types';

export function Inspector() {
  const tab = useUIStore((s) => s.inspectorTab);
  const patch = useUIStore((s) => s.patch);

  return (
    <div className="panel panel--right">
      <div className="tabs">
        {(['object', 'style', 'project'] as const).map((t) => (
          <button
            key={t}
            className={`tab${tab === t ? ' tab--active' : ''}`}
            onClick={() => patch({ inspectorTab: t })}
          >
            {t === 'object' ? 'Object' : t === 'style' ? 'Styles' : 'Project'}
          </button>
        ))}
      </div>
      <div className="panel__body">
        {tab === 'object' && <ObjectTab />}
        {tab === 'style' && <StylePanel />}
        {tab === 'project' && <ProjectPanel />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ObjectTab() {
  const project = useProjectStore((s) => s.project);
  const selection = useUIStore((s) => s.selection);
  const tool = useUIStore((s) => s.tool);

  if (tool === 'paint') return <PaintPanel />;
  if (tool === 'fill') return <FillPanel />;

  if (selection.length === 0) {
    return (
      <div className="empty">
        Nothing selected.
        <br />
        <br />
        Click an object on the map, or shift-drag to select several.
      </div>
    );
  }

  if (selection.length > 1) return <MultiSelection />;

  const id = selection[0];
  if (project.territories[id]) return <TerritoryInspector territory={project.territories[id]} />;
  if (project.settlements[id]) return <SettlementInspector settlement={project.settlements[id]} />;
  if (project.labels[id]) return <LabelInspector label={project.labels[id]} />;
  if (project.linearFeatures[id]) return <LinearInspector feature={project.linearFeatures[id]} />;
  return <div className="empty">That object no longer exists.</div>;
}

// ---------------------------------------------------------------------------
// Territory (spec §20)
// ---------------------------------------------------------------------------

function TerritoryInspector({ territory: t }: { territory: Territory }) {
  const project = useProjectStore((s) => s.project);
  const style = resolveTerritoryStyle(project, t);
  const area = useMemo(() => areaKm2(t.geometry), [t.geometry]);
  const subtitle = relationshipSubtitle(project, t);

  const update = (changes: Partial<Territory>, label = 'Edit territory') =>
    commit(label, (r) => r.update<Territory>('territories', t.id, changes));

  const setStyle = (changes: Partial<TerritoryStyle>) =>
    commit('Edit territory style', (r) =>
      r.update<Territory>('territories', t.id, { styleOverrides: { ...t.styleOverrides, ...changes } }),
    );

  const parents = Object.values(project.territories).filter((o) => o.id !== t.id);

  return (
    <>
      <Section title="Territory">
        <Field label="Name">
          <input className="input" value={t.name} onChange={(e) => update({ name: e.target.value })} />
        </Field>
        <Field label="Short name">
          <input
            className="input"
            value={t.shortName}
            placeholder="optional"
            onChange={(e) => update({ shortName: e.target.value })}
          />
        </Field>
        <Field label="Political type">
          <select
            className="select"
            value={String(t.politicalType)}
            onChange={(e) => {
              const type = e.target.value;
              const info = POLITICAL_TYPES.find((p) => p.value === type);
              update({ politicalType: type, borderKind: info?.border ?? t.borderKind }, 'Change political type');
            }}
          >
            {POLITICAL_TYPES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            {!POLITICAL_TYPES.some((p) => p.value === t.politicalType) && (
              <option value={String(t.politicalType)}>{String(t.politicalType)} (custom)</option>
            )}
          </select>
        </Field>
        <Field label="Custom type">
          <input
            className="input"
            placeholder="type a custom rank"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const value = (e.target as HTMLInputElement).value.trim();
              if (value) {
                update({ politicalType: value }, 'Set custom political type');
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
        </Field>
        <Field label="Parent">
          <select
            className="select"
            value={t.parentId ?? ''}
            onChange={(e) => setParent(t.id, e.target.value || null)}
          >
            <option value="">— none (sovereign) —</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Liege">
          <select
            className="select"
            value={t.liegeId ?? ''}
            onChange={(e) => update({ liegeId: e.target.value || null }, 'Set liege')}
          >
            <option value="">— none —</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Capital">
          <CapitalField territory={t} />
        </Field>
        {/* Status, not rank. The two above it — political type and parent — say
            what this is called and who holds it; this says on what terms, which
            is what the fill, the border and the label under the name all come
            from. */}
        <Field label="Status">
          <select
            className="select"
            value={String(t.relationship)}
            onChange={(e) => setRelationship(t.id, e.target.value)}
          >
            {POLITICAL_RELATIONSHIPS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
        {subtitle && (
          <p className="hint" style={{ marginTop: -2 }}>
            Labelled <em>{subtitle}</em> beneath its name.
          </p>
        )}
        {t.relationship !== 'sovereign' && !t.parentId && (
          <p className="hint" style={{ marginTop: -2 }}>
            Held on those terms by nobody — set a parent realm above, or this reads as sovereign.
          </p>
        )}
      </Section>

      <Section title="Appearance">
        <Field label="Fill">
          <input
            className="color-input"
            type="color"
            value={style.fillColor.slice(0, 7)}
            onChange={(e) => setTerritoryFill([t.id], e.target.value)}
          />
        </Field>
        <Field label="Opacity">
          <Slider
            value={style.fillOpacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => setStyle({ fillOpacity: v })}
          />
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={t.inheritParentColor}
            disabled={!t.parentId}
            onChange={(e) => update({ inheritParentColor: e.target.checked }, 'Colour inheritance')}
          />
          Tint from parent state
        </label>
        <Field label="Border">
          <select
            className="select"
            value={String(t.borderKind)}
            onChange={(e) => update({ borderKind: e.target.value }, 'Change border weight')}
          >
            {BORDER_HIERARCHY.map((b) => (
              <option key={String(b.kind)} value={String(b.kind)}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Style class">
          <select
            className="select"
            value={t.styleClassId}
            onChange={(e) => update({ styleClassId: e.target.value }, 'Change style class')}
          >
            {Object.values(project.styles.territory).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <PatternEditor
          pattern={style.pattern}
          onChange={(pattern) => setStyle({ pattern })}
        />

        <div className="panel__section-title" style={{ marginTop: 9 }}>Palette</div>
        <div className="swatches">
          {PALETTES['historical-atlas'].concat(PALETTES.pastel).map((c) => (
            <button
              key={c}
              className="swatch"
              style={{ background: c }}
              title={c}
              onClick={() => setTerritoryFill([t.id], c)}
            />
          ))}
        </div>
      </Section>

      <Section title="Dates">
        <div className="split-2">
          <Field label="Start" compact>
            <input
              className="input input--number"
              type="number"
              placeholder="—"
              value={t.timeline.start ?? ''}
              onChange={(e) =>
                update(
                  { timeline: { ...t.timeline, start: e.target.value === '' ? null : Number(e.target.value) } },
                  'Set start year',
                )
              }
            />
          </Field>
          <Field label="End" compact>
            <input
              className="input input--number"
              type="number"
              placeholder="—"
              value={t.timeline.end ?? ''}
              onChange={(e) =>
                update(
                  { timeline: { ...t.timeline, end: e.target.value === '' ? null : Number(e.target.value) } },
                  'Set end year',
                )
              }
            />
          </Field>
        </div>
      </Section>

      <Section title="Notes">
        <textarea
          className="textarea"
          value={t.notes}
          onChange={(e) => update({ notes: e.target.value })}
        />
        <p className="hint">
          Area {formatArea(area)} · {t.locked ? 'locked' : 'unlocked'}
        </p>
      </Section>

      <Section title="Geometry">
        <div className="btn-row">
          <button className="btn" onClick={() => simplifySelection(0.005)} title="Douglas–Peucker simplification">
            Simplify
          </button>
          <button className="btn" onClick={() => smoothSelection(1)} title="Chaikin corner cutting">
            Smooth
          </button>
          <button className="btn" onClick={() => duplicateSelection()}>
            Duplicate
          </button>
        </div>
        <div className="btn-row" style={{ marginTop: 5 }}>
          <button className="btn" onClick={() => setLockedFor([t.id], !t.locked)}>
            {t.locked ? 'Unlock' : 'Lock'}
          </button>
          <button className="btn" onClick={() => setHiddenFor([t.id], !t.hidden)}>
            {t.hidden ? 'Show' : 'Hide'}
          </button>
          <button className="btn btn--danger" onClick={() => deleteSelection()}>
            Delete
          </button>
        </div>
      </Section>
    </>
  );
}

const HATCH_KINDS: { value: HatchKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'diagonal', label: '//// Diagonal' },
  { value: 'reverse-diagonal', label: '\\\\\\\\ Reverse' },
  { value: 'crosshatch', label: 'xxxx Crosshatch' },
  { value: 'dots', label: '.... Dots' },
  { value: 'vertical', label: '|||| Vertical' },
  { value: 'horizontal', label: '==== Horizontal' },
];

function PatternEditor({
  pattern,
  onChange,
}: {
  pattern: TerritoryStyle['pattern'];
  onChange: (p: TerritoryStyle['pattern']) => void;
}) {
  const current = pattern ?? { kind: 'none' as HatchKind, angle: 0, spacing: 7, thickness: 1, color: '#6b5f4d', opacity: 0.7 };
  return (
    <>
      <Field label="Pattern">
        <select
          className="select"
          value={current.kind}
          onChange={(e) => {
            const kind = e.target.value as HatchKind;
            onChange(kind === 'none' ? null : { ...current, kind });
          }}
        >
          {HATCH_KINDS.map((h) => (
            <option key={h.value} value={h.value}>
              {h.label}
            </option>
          ))}
        </select>
      </Field>
      {pattern && pattern.kind !== 'none' && (
        <>
          <Field label="Angle">
            <Slider value={pattern.angle} min={0} max={180} step={5} onChange={(v) => onChange({ ...pattern, angle: v })} suffix="°" />
          </Field>
          <Field label="Spacing">
            <Slider value={pattern.spacing} min={2} max={26} step={1} onChange={(v) => onChange({ ...pattern, spacing: v })} suffix="px" />
          </Field>
          <Field label="Thickness">
            <Slider value={pattern.thickness} min={0.3} max={4} step={0.1} onChange={(v) => onChange({ ...pattern, thickness: v })} />
          </Field>
          <Field label="Colour">
            <input
              className="color-input"
              type="color"
              value={pattern.color.slice(0, 7)}
              onChange={(e) => onChange({ ...pattern, color: e.target.value })}
            />
          </Field>
          <Field label="Pattern α">
            <Slider value={pattern.opacity} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...pattern, opacity: v })} />
          </Field>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Settlement (spec §14, §20)
// ---------------------------------------------------------------------------

function SettlementInspector({ settlement: s }: { settlement: Settlement }) {
  const project = useProjectStore((s2) => s2.project);
  const style = resolveSymbolStyle(project, s);
  const nameLabel = s.labelId ? project.labels[s.labelId] : undefined;
  const nameStyle = nameLabel ? resolveTextStyle(project, nameLabel) : undefined;
  const update = (changes: Partial<Settlement>, label = 'Edit settlement') =>
    commit(label, (r) => r.update<Settlement>('settlements', s.id, changes));

  return (
    <>
      <Section title="Settlement">
        <Field label="Name">
          <input
            className="input"
            value={s.name}
            onChange={(e) => {
              const name = e.target.value;
              commit('Rename settlement', (r) => {
                r.update<Settlement>('settlements', s.id, { name });
                if (s.labelId) r.update<MapLabel>('labels', s.labelId, { text: name, name });
              });
            }}
          />
        </Field>
        <Field label="Type">
          <select
            className="select"
            value={String(s.type)}
            onChange={(e) => {
              const type = e.target.value;
              const info = SETTLEMENT_TYPES.find((x) => x.value === type);
              update({ type, styleClassId: info?.styleClassId ?? s.styleClassId }, 'Change settlement type');
            }}
          >
            {SETTLEMENT_TYPES.map((x) => (
              <option key={String(x.value)} value={String(x.value)}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Population">
          <input
            className="input input--number"
            type="number"
            value={s.population ?? ''}
            placeholder="—"
            onChange={(e) => update({ population: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </Field>
        <Field label="Owner">
          <select
            className="select"
            value={s.ownerId ?? ''}
            onChange={(e) => update({ ownerId: e.target.value || null }, 'Set owner')}
          >
            <option value="">— none —</option>
            {Object.values(project.territories).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Coordinates">
          <span className="mono">
            {s.geometry.coordinates[1].toFixed(4)}, {s.geometry.coordinates[0].toFixed(4)}
          </span>
        </Field>
      </Section>

      {/* A town's name is a label of its own, and selecting the town is what
          you do when you mean the town — clicking the four pixels of text
          beside a capital's ring to reach its size is not an interface. So the
          two controls that decide how the name is drawn are repeated here; the
          rest of a label's settings stay behind the label itself. */}
      {nameLabel && (
        <Section title="Name">
          <Field label="Size">
            <Slider
              value={nameStyle!.fontSize}
              min={1}
              max={Math.max(40, Math.ceil(nameStyle!.fontSize / 20) * 20)}
              step={0.5}
              onChange={(v) =>
                commit('Name size', (r) =>
                  r.update<MapLabel>('labels', nameLabel.id, {
                    styleOverrides: { ...nameLabel.styleOverrides, fontSize: v },
                  }),
                )
              }
              suffix="px"
            />
          </Field>
          <FixedSizeSwitch label={nameLabel} />
        </Section>
      )}

      <Section title="Symbol">
        <Field label="Shape">
          <select
            className="select"
            value={style.shape}
            onChange={(e) =>
              update(
                { styleOverrides: { ...s.styleOverrides, shape: e.target.value as SymbolShape } },
                'Symbol shape',
              )
            }
          >
            {SYMBOL_SHAPES.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
            {/* A symbol drawing a supplied path is not something you pick, but
                the menu still has to be able to show what it currently is. */}
            {style.shape === 'custom-svg' && <option value="custom-svg">Custom path</option>}
          </select>
        </Field>
        <Field label="Size">
          <Slider
            value={style.size}
            min={2}
            max={26}
            step={0.5}
            onChange={(v) => update({ styleOverrides: { ...s.styleOverrides, size: v } }, 'Symbol size')}
          />
        </Field>
        <Field label="Fill">
          <input
            className="color-input"
            type="color"
            value={style.fillColor.slice(0, 7)}
            onChange={(e) =>
              update({ styleOverrides: { ...s.styleOverrides, fillColor: e.target.value } }, 'Symbol colour')
            }
          />
        </Field>
        <Field label="Stroke">
          <input
            className="color-input"
            type="color"
            value={style.strokeColor.slice(0, 7)}
            onChange={(e) =>
              update({ styleOverrides: { ...s.styleOverrides, strokeColor: e.target.value } }, 'Symbol colour')
            }
          />
        </Field>
        <Field label="Style class">
          <select
            className="select"
            value={s.styleClassId}
            onChange={(e) => update({ styleClassId: e.target.value }, 'Change symbol class')}
          >
            {Object.values(project.styles.symbol).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Actions">
        <div className="btn-row">
          <button className="btn" onClick={() => duplicateSelection()}>Duplicate</button>
          <button className="btn" onClick={() => setLockedFor([s.id], !s.locked)}>{s.locked ? 'Unlock' : 'Lock'}</button>
          <button className="btn btn--danger" onClick={() => deleteSelection()}>Delete</button>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Label (spec §10, §11, §12, §20, §42)
// ---------------------------------------------------------------------------

/**
 * The factor the map would draw this label's type at if it were free to scale
 * (spec §42), tracked across zoom so the panel never quotes a stale number.
 *
 * Asked as if the label were unpinned on purpose: the inspector needs the size
 * the name would grow to, both to say so and to fold it into the style when the
 * name is pinned. A pinned label's own scale is 1 by definition and would tell
 * the panel nothing.
 */
function useLabelScale(
  controller: MapController | null,
  l: MapLabel,
  project: MapProject,
  style: TextStyle,
): number {
  const read = () => controller?.labelScale({ ...l, fixedSize: false }, project, style) ?? 1;
  const [scale, setScale] = useState(read);

  useEffect(() => {
    if (!controller) return;
    const view = controller.map.getView();
    const onChange = () => setScale((prev) => {
      const next = read();
      return Math.abs(next - prev) < 0.005 ? prev : next;
    });
    onChange();
    view.on('change:resolution', onChange);
    return () => view.un('change:resolution', onChange);
    // Re-read when the label or the document behind it changes, not only on zoom.
  }, [controller, l, project, style.fontSize, style.tracking]);

  return scale;
}

/**
 * The switch that pins a name's size, wherever that name is being edited (§42).
 *
 * Its own component because a name is edited from more than one place. Select
 * the text and you are in the label inspector; select the town the text belongs
 * to — which is what you click when you mean the capital — and you are in the
 * settlement inspector, where until now there was no way to pin its name
 * without first hunting for the label behind it.
 */
function FixedSizeSwitch({ label: l }: { label: MapLabel }) {
  const project = useProjectStore((s) => s.project);
  const style = resolveTextStyle(project, l);
  const attachedToTerritory = !!l.attachedToId && !!project.territories[l.attachedToId];

  // What the map is currently multiplying this label's type size by (§42).
  const controller = useMapController();
  const scale = useLabelScale(controller, l, project, style);

  /**
   * Pin a name at the size it is drawn at, rather than at the size it is set to.
   *
   * An unpinned territory name is drawn at `style size × scale`, so pinning it
   * naively snaps it to the style size — at a regional zoom that is a name
   * suddenly 2.5× smaller, which looks like the switch broke something. Folding
   * the scale into the style as the flag goes on (and dividing it back out as it
   * comes off) leaves the glyphs exactly where they were through the click: what
   * changes is what happens on the *next* zoom, which is the whole point.
   */
  const setFixedSize = (fixed: boolean) => {
    const changes: Partial<MapLabel> = { fixedSize: fixed };
    if (Math.abs(scale - 1) > 0.01) {
      const held = pinnedText(style, scale, fixed);
      changes.styleOverrides = {
        ...l.styleOverrides,
        fontSize: held.fontSize,
        tracking: held.tracking,
        haloWidth: held.haloWidth,
      };
    }
    commit(fixed ? 'Pin label size' : 'Let label scale', (r) =>
      r.update<MapLabel>('labels', l.id, changes),
    );
  };

  return (
    <>
      <label className="checkbox">
        <input type="checkbox" checked={l.fixedSize} onChange={(e) => setFixedSize(e.target.checked)} />
        Fixed size (do not scale with zoom)
      </label>
      <p className="hint" style={{ marginTop: -2 }}>
        {l.fixedSize
          ? 'Pinned at its set size whatever the zoom.'
          : attachedToTerritory
            ? `Grows and shrinks with the land it names, so it spans its territory at every scale — drawn at ${
                Math.round(scale * 100)
              }% of its set size at this zoom.`
            : `Grows and shrinks with the map, so it spans the same ground at every scale — drawn at ${
                Math.round(scale * 100)
              }% of its set size at this zoom.`}
      </p>
    </>
  );
}

function LabelInspector({ label: l }: { label: MapLabel }) {
  const project = useProjectStore((s) => s.project);
  const style = resolveTextStyle(project, l);
  const update = (changes: Partial<MapLabel>, name = 'Edit label') =>
    commit(name, (r) => r.update<MapLabel>('labels', l.id, changes));
  const setStyle = (changes: Partial<TextStyle>) =>
    update({ styleOverrides: { ...l.styleOverrides, ...changes } }, 'Edit label style');

  const paths = Object.values(project.linearFeatures);

  return (
    <>
      <Section title="Label">
        <Field label="Text" wide>
          <textarea
            className="textarea"
            style={{ minHeight: 40 }}
            value={l.text}
            onChange={(e) => update({ text: e.target.value })}
          />
        </Field>
        <Field label="Kind">
          <select
            className="select"
            value={l.kind}
            onChange={(e) => {
              const kind = e.target.value as MapLabel['kind'];
              const styleByKind: Record<string, string> = {
                country: STYLE_IDS.textCountry,
                region: STYLE_IDS.textRegion,
                city: STYLE_IDS.textCity,
                water: STYLE_IDS.textWater,
                ocean: STYLE_IDS.textOcean,
                river: STYLE_IDS.textRiver,
                mountain: STYLE_IDS.textRegion,
                free: STYLE_IDS.textRegion,
              };
              // The kind carries its typography and whether it is pinned: this
              // control already swaps the whole text class, so leaving the one
              // flag behind would make a country name that behaves like a river.
              update(
                { kind, styleClassId: styleByKind[kind] ?? l.styleClassId, fixedSize: defaultFixedSize(kind) },
                'Change label kind',
              );
            }}
          >
            {['country', 'region', 'city', 'water', 'ocean', 'river', 'mountain', 'free'].map((k) => (
              <option key={k} value={k}>
                {k[0].toUpperCase() + k.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Style class">
          <select
            className="select"
            value={l.styleClassId}
            onChange={(e) => update({ styleClassId: e.target.value }, 'Change text class')}
          >
            {Object.values(project.styles.text).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Typography">
        <Field label="Font">
          <select className="select" value={style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value })}>
            {FONT_STACKS.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
            {!FONT_STACKS.some((f) => f.value === style.fontFamily) && (
              <option value={style.fontFamily}>Custom</option>
            )}
          </select>
        </Field>
        <Field label="Size">
          {/* The track stretches to fit: a realm's name pinned at a close zoom
              carries the scale it was drawn at, which runs well past ordinary
              type sizes, and a slider whose thumb is stuck at the end cannot be
              used to make it smaller again. */}
          <Slider
            value={style.fontSize}
            min={1}
            max={Math.max(80, Math.ceil(style.fontSize / 20) * 20)}
            step={0.5}
            onChange={(v) => setStyle({ fontSize: v })}
            suffix="px"
          />
        </Field>
        <Field label="Tracking">
          <Slider
            value={style.tracking}
            min={-3}
            max={Math.max(40, Math.ceil(style.tracking / 10) * 10)}
            step={0.5}
            onChange={(v) => setStyle({ tracking: v })}
            suffix="px"
          />
        </Field>
        <Field label="Line height">
          <Slider value={style.lineHeight} min={0.8} max={2.4} step={0.05} onChange={(v) => setStyle({ lineHeight: v })} />
        </Field>
        <Field label="Weight">
          <select
            className="select"
            value={style.fontWeight}
            onChange={(e) => setStyle({ fontWeight: Number(e.target.value) })}
          >
            {[300, 400, 500, 600, 700, 800].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Case">
          <select
            className="select"
            value={style.transform}
            onChange={(e) => setStyle({ transform: e.target.value as TextStyle['transform'] })}
          >
            <option value="none">As typed</option>
            <option value="uppercase">UPPERCASE</option>
            <option value="lowercase">lowercase</option>
            <option value="capitalize">Capitalise</option>
          </select>
        </Field>
        <Field label="Align">
          <select
            className="select"
            value={style.align}
            onChange={(e) => setStyle({ align: e.target.value as TextStyle['align'] })}
          >
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={style.italic} onChange={(e) => setStyle({ italic: e.target.checked })} />
          Italic
        </label>
        <Field label="Colour">
          <input
            className="color-input"
            type="color"
            value={style.color.slice(0, 7)}
            onChange={(e) => setStyle({ color: e.target.value })}
          />
        </Field>
        <Field label="Halo">
          <input
            className="color-input"
            type="color"
            value={(style.haloColor ?? '#ffffff').slice(0, 7)}
            onChange={(e) => setStyle({ haloColor: e.target.value })}
          />
        </Field>
        <Field label="Halo width">
          <Slider value={style.haloWidth} min={0} max={9} step={0.25} onChange={(v) => setStyle({ haloWidth: v })} />
        </Field>
        <Field label="Text α">
          <Slider value={style.opacity} min={0} max={1} step={0.05} onChange={(v) => setStyle({ opacity: v })} />
        </Field>
      </Section>

      <Section title="Placement">
        <Field label="Rotation">
          <Slider value={l.rotation} min={-180} max={180} step={1} onChange={(v) => update({ rotation: v }, 'Rotate label')} suffix="°" />
        </Field>
        <Field label="Curve">
          <Slider
            value={l.curve}
            min={-1}
            max={1}
            step={0.02}
            onChange={(v) => update({ curve: v }, 'Curve label')}
          />
        </Field>
        <p className="hint" style={{ marginTop: 0 }}>
          Bends the name along an arc: right of centre arches it upwards, left cups it downwards. A
          bent name is set on one line.
          {l.pathId ? ' This one follows a path, which takes precedence over the bend.' : ''}
        </p>
        <div className="split-2">
          <Field label="Offset X" compact>
            <input
              className="input input--number"
              type="number"
              value={l.offset[0]}
              onChange={(e) => update({ offset: [Number(e.target.value), l.offset[1]] }, 'Offset label')}
            />
          </Field>
          <Field label="Offset Y" compact>
            <input
              className="input input--number"
              type="number"
              value={l.offset[1]}
              onChange={(e) => update({ offset: [l.offset[0], Number(e.target.value)] }, 'Offset label')}
            />
          </Field>
        </div>
        <Field label="Follow path">
          <select
            className="select"
            value={l.pathId ?? ''}
            onChange={(e) => update({ pathId: e.target.value || null }, 'Set label path')}
            title="Run the text along a river, road or invisible guide line"
          >
            <option value="">— straight —</option>
            {paths.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={l.manualPosition}
            onChange={(e) => update({ manualPosition: e.target.checked }, 'Manual placement')}
          />
          Manual position (ignore auto-placement)
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={l.ignoreCollisions}
            onChange={(e) => update({ ignoreCollisions: e.target.checked }, 'Collision exemption')}
          />
          Exempt from collision warnings
        </label>
        <FixedSizeSwitch label={l} />
      </Section>

      <Section title="Actions">
        <div className="btn-row">
          <button className="btn" onClick={() => duplicateSelection()}>Duplicate</button>
          <button className="btn" onClick={() => setLockedFor([l.id], !l.locked)}>{l.locked ? 'Unlock' : 'Lock'}</button>
          <button className="btn" onClick={() => setHiddenFor([l.id], !l.hidden)}>{l.hidden ? 'Show' : 'Hide'}</button>
          <button className="btn btn--danger" onClick={() => deleteSelection()}>Delete</button>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rivers and roads (spec §15, §16)
// ---------------------------------------------------------------------------

const LINEAR_KINDS = [
  'river', 'river-major', 'canal',
  'road-major', 'road-minor', 'roman-road', 'trade-route', 'trail', 'sea-route',
  'label-path',
];

function LinearInspector({ feature: f }: { feature: LinearFeature }) {
  const project = useProjectStore((s) => s.project);
  const update = (changes: Partial<LinearFeature>, label = 'Edit line') =>
    commit(label, (r) => r.update<LinearFeature>('linearFeatures', f.id, changes));

  return (
    <>
      <Section title={f.kind.startsWith('river') ? 'River' : 'Road'}>
        <Field label="Name">
          <input className="input" value={f.name} onChange={(e) => update({ name: e.target.value })} />
        </Field>
        <Field label="Kind">
          <select className="select" value={String(f.kind)} onChange={(e) => update({ kind: e.target.value }, 'Change line kind')}>
            {LINEAR_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/-/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Style class">
          <select className="select" value={f.styleClassId} onChange={(e) => update({ styleClassId: e.target.value }, 'Change line class')}>
            {Object.values(project.styles.line).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Flows into">
          <select
            className="select"
            value={f.flowsIntoId ?? ''}
            onChange={(e) => update({ flowsIntoId: e.target.value || null }, 'Set tributary')}
          >
            <option value="">— none —</option>
            {Object.values(project.linearFeatures)
              .filter((o) => o.id !== f.id)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </select>
        </Field>
      </Section>
      <Section title="Actions">
        <div className="btn-row">
          <button className="btn" onClick={() => setLockedFor([f.id], !f.locked)}>{f.locked ? 'Unlock' : 'Lock'}</button>
          <button className="btn" onClick={() => setHiddenFor([f.id], !f.hidden)}>{f.hidden ? 'Show' : 'Hide'}</button>
          <button className="btn btn--danger" onClick={() => deleteSelection()}>Delete</button>
        </div>
        <p className="hint">Use the vertex tool to reshape the line.</p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Multiple selection — bulk editing (spec §39) and territory operations (§5)
// ---------------------------------------------------------------------------

function MultiSelection() {
  const project = useProjectStore((s) => s.project);
  const selection = useUIStore((s) => s.selection);
  const counts = useMemo(() => {
    let territories = 0;
    let settlements = 0;
    let labels = 0;
    let lines = 0;
    for (const id of selection) {
      if (project.territories[id]) territories++;
      else if (project.settlements[id]) settlements++;
      else if (project.labels[id]) labels++;
      else if (project.linearFeatures[id]) lines++;
    }
    return { territories, settlements, labels, lines };
  }, [selection, project]);

  return (
    <>
      <Section title={`${selection.length} objects selected`}>
        <p className="hint" style={{ marginTop: 0 }}>
          {[
            counts.territories && `${counts.territories} territories`,
            counts.settlements && `${counts.settlements} settlements`,
            counts.labels && `${counts.labels} labels`,
            counts.lines && `${counts.lines} lines`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </Section>

      {counts.territories >= 1 && (
        <Section title="Territory operations">
          <div className="btn-row">
            <button className="btn" disabled={counts.territories < 2} onClick={mergeSelected} title="Union the shapes into the first selected territory">
              Merge
            </button>
            <button className="btn" disabled={counts.territories < 2} onClick={subtractSelected} title="Subtract the others from the first selected">
              Subtract
            </button>
          </div>
          <button
            className="btn btn--accent btn--full"
            style={{ marginTop: 6 }}
            onClick={() => createTerritoryFromSelection()}
            title="Dissolve internal borders into one new state, keeping these as subdivisions"
          >
            Create Territory from Selection
          </button>
          <p className="hint">
            Dissolves the internal borders and keeps the originals as subordinate divisions.
          </p>
        </Section>
      )}

      <Section title="Bulk edit">
        {counts.territories > 0 && (
          <>
            <Field label="Fill all">
              <input
                className="color-input"
                type="color"
                defaultValue="#d8c9a8"
                onChange={(e) => setTerritoryFill(selection, e.target.value)}
              />
            </Field>
            <Field label="Border">
              <select
                className="select"
                defaultValue=""
                onChange={(e) => e.target.value && bulkUpdate({ territory: { borderKind: e.target.value } })}
              >
                <option value="">— set border weight —</option>
                {BORDER_HIERARCHY.map((b) => (
                  <option key={String(b.kind)} value={String(b.kind)}>
                    {b.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Type">
              <select
                className="select"
                defaultValue=""
                onChange={(e) => e.target.value && bulkUpdate({ territory: { politicalType: e.target.value } })}
              >
                <option value="">— set political type —</option>
                {POLITICAL_TYPES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Parent">
              <select
                className="select"
                defaultValue=""
                onChange={(e) => bulkUpdate({ territory: { parentId: e.target.value || null } })}
              >
                <option value="">— set parent —</option>
                <option value="">none (sovereign)</option>
                {Object.values(project.territories)
                  .filter((t) => !selection.includes(t.id))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </Field>
          </>
        )}
        {counts.labels > 0 && (
          <>
            <Field label="Label size">
              <input
                className="input input--number"
                type="number"
                placeholder="px"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const v = Number((e.target as HTMLInputElement).value);
                  if (Number.isFinite(v) && v > 0) applyLabelStyle(selection, { fontSize: v });
                }}
              />
            </Field>
            <Field label="Tracking">
              <input
                className="input input--number"
                type="number"
                placeholder="px"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const v = Number((e.target as HTMLInputElement).value);
                  if (Number.isFinite(v)) applyLabelStyle(selection, { tracking: v });
                }}
              />
            </Field>
            <Field label="Font">
              <select
                className="select"
                defaultValue=""
                onChange={(e) => e.target.value && applyLabelStyle(selection, { fontFamily: e.target.value })}
              >
                <option value="">— set font —</option>
                {FONT_STACKS.map((f) => (
                  <option key={f.label} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <p className="hint">Press Enter in a number field to apply it to everything selected.</p>
      </Section>

      <Section title="Actions">
        <div className="btn-row">
          <button className="btn" onClick={() => duplicateSelection()}>Duplicate</button>
          <button className="btn" onClick={() => setLockedFor(selection, true)}>Lock</button>
          <button className="btn" onClick={() => setLockedFor(selection, false)}>Unlock</button>
          <button className="btn btn--danger" onClick={() => deleteSelection()}>Delete</button>
        </div>
      </Section>
    </>
  );
}

function applyLabelStyle(ids: string[], changes: Partial<TextStyle>) {
  const project = getProject();
  commit('Bulk label style', (r) => {
    for (const id of ids) {
      const l = project.labels[id];
      if (!l) continue;
      r.update<MapLabel>('labels', id, { styleOverrides: { ...l.styleOverrides, ...changes } });
    }
  });
}

// ---------------------------------------------------------------------------
// Paint tool panel (spec §56)
// ---------------------------------------------------------------------------

/**
 * The paint bucket (spec §6, §57).
 *
 * The panel exists to answer the two questions a click cannot: which realm the
 * ground goes to, and what the flood is allowed to cross. Both are read off the
 * rest of the application rather than set here — the selection, and the layers
 * that are switched on — so the panel mostly reports, and the one switch it owns
 * is the one that has no other home.
 */
function FillPanel() {
  const project = useProjectStore((s) => s.project);
  const selection = useUIStore((s) => s.selection);
  const stops = useUIStore((s) => s.fillStopsAtLines);
  const patch = useUIStore((s) => s.patch);

  const target = selection.map((id) => project.territories[id]).find(Boolean);
  const lines = selection.map((id) => project.linearFeatures[id]).filter(Boolean);
  const layers = barrierSources(project);
  const own = Object.values(project.linearFeatures).filter((f) => f.kind !== 'label-path').length;

  return (
    <>
      <Section title="Fill">
        <p className="hint" style={{ marginTop: 0 }}>
          Click ground and it goes to one realm. Land nobody holds joins the realm beside it;
          land somebody holds changes hands, which needs the receiving realm selected first.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span
            className="tree-row__swatch"
            style={{
              width: 18,
              height: 18,
              background: target ? resolveTerritoryStyle(project, target).fillColor : 'transparent',
              border: target ? undefined : '1px dashed var(--line)',
            }}
          />
          <strong>{target ? target.name : 'whoever borders it'}</strong>
        </div>
      </Section>

      <Section title="Stop at">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={stops}
            onChange={(e) => patch({ fillStopsAtLines: e.target.checked })}
          />
          Stop at rivers and boundaries
        </label>
        {stops ? (
          lines.length ? (
            <p className="hint">
              {lines.length === 1 ? lines[0].name : `${lines.length} selected lines`} — selected, so nothing
              else counts. Deselect to use every line on the map.
            </p>
          ) : (
            <p className="hint">
              {[layers.map((l) => l.name).join(', '), own ? `${own} drawn on the map` : '']
                .filter(Boolean)
                .join(', ') || 'Nothing is switched on to stop at — turn a reference layer on, or draw a river.'}
              {layers.length || own ? '. Select one line to use only that one.' : ''}
            </p>
          )
        ) : (
          <p className="hint">The flood runs to the coast and to whatever anyone already holds.</p>
        )}
      </Section>
    </>
  );
}

function PaintPanel() {
  const project = useProjectStore((s) => s.project);
  const paintTargetId = useUIStore((s) => s.paintTargetId);
  const patch = useUIStore((s) => s.patch);
  const controller = useMapController();

  const candidates = Object.values(project.territories).sort((a, b) => a.name.localeCompare(b.name));
  const target = paintTargetId ? project.territories[paintTargetId] : null;

  return (
    <>
      <Section title="Paint territory">
        <p className="hint" style={{ marginTop: 0 }}>
          Choose the state to paint with, then drag across subdivisions on the map to assign them to it.
          Their internal borders drop to county weight and the state's outline grows to cover them.
        </p>
        <Field label="Assign to">
          <select
            className="select"
            value={paintTargetId ?? ''}
            onChange={(e) => patch({ paintTargetId: e.target.value || null })}
          >
            <option value="">— choose a state —</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        {target && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span
              className="tree-row__swatch"
              style={{ width: 18, height: 18, background: resolveTerritoryStyle(project, target).fillColor }}
            />
            <strong>{target.name}</strong>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => controller?.zoomToFeature(target.id)}>
              Zoom
            </button>
          </div>
        )}
        {candidates.length === 0 && (
          <p className="hint">
            No territories yet. Import reference geography from the Basemap panel, or draw a state first.
          </p>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small shared controls
// ---------------------------------------------------------------------------

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel__section">
      <h3 className="panel__section-title">{title}</h3>
      {children}
    </div>
  );
}

export function Field({
  label,
  children,
  wide,
  compact,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`field${wide ? ' field--wide' : ''}`} style={compact ? { gridTemplateColumns: '1fr' } : undefined}>
      <label className="field__label">{label}</label>
      {children}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="mono" style={{ width: 44, textAlign: 'right', flex: 'none' }}>
        {Number(value.toFixed(2))}
        {suffix ?? ''}
      </span>
    </div>
  );
}

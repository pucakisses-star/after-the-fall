/**
 * "Convert reference geography to territories" (spec §3, §55).
 *
 * This is the fast path onto a real map: pick a dataset, filter it down to the
 * features you want, and either import them as individual divisions or dissolve
 * them into a single new state.
 */

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '../Dialog';
import { Field } from '../Inspector';
import {
  BUILTIN_BASEMAPS,
  STATE_FIPS,
  allBasemapSources,
  basemapFeatureName,
  loadBasemap,
  type PolyFeature,
} from '@/geo/basemap';
import { convertBasemapToTerritories, territoryFromBasemapFeatures } from '@/io/importers';
import { BORDER_HIERARCHY, POLITICAL_TYPES } from '@/model/defaults';
import { toast } from '@/state/uiStore';
import { useProjectStore } from '@/state/projectStore';
import { useMapController } from '../MapContext';
import type { BorderStyleKind, PoliticalType } from '@/model/types';

type Mode = 'divisions' | 'single-state';

export function BasemapDialog({ onClose }: { onClose: () => void }) {
  const controller = useMapController();
  const project = useProjectStore((s) => s.project);
  const sources = allBasemapSources();
  const [sourceId, setSourceId] = useState(BUILTIN_BASEMAPS[4].id); // us-states
  const [features, setFeatures] = useState<PolyFeature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>('divisions');
  const [name, setName] = useState('New Kingdom');
  const [politicalType, setPoliticalType] = useState<PoliticalType>('kingdom');
  const [divisionType, setDivisionType] = useState<PoliticalType>('province');
  const [borderKind, setBorderKind] = useState<BorderStyleKind>('provincial');
  const [keepSubdivisions, setKeepSubdivisions] = useState(true);
  const [busy, setBusy] = useState(false);

  const isCounties = sourceId === 'us-counties';

  useEffect(() => {
    let cancelled = false;
    setFeatures(null);
    setError(null);
    setChosen(new Set());
    loadBasemap(sourceId)
      .then((f) => !cancelled && setFeatures(f))
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  const rows = useMemo(() => {
    if (!features) return [];
    const q = filter.trim().toLowerCase();
    return features
      .map((f) => ({
        name: basemapFeatureName(f),
        fips: typeof f.id === 'number' || typeof f.id === 'string' ? String(f.id).padStart(5, '0').slice(0, 2) : '',
      }))
      .filter((r) => (q ? r.name.toLowerCase().includes(q) : true))
      .filter((r) => (isCounties && stateFilter ? r.fips === stateFilter : true))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [features, filter, stateFilter, isCounties]);

  const toggle = (n: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };

  const run = async () => {
    setBusy(true);
    try {
      if (mode === 'single-state') {
        const names = chosen.size ? [...chosen] : rows.map((r) => r.name);
        const id = await territoryFromBasemapFeatures(
          sourceId,
          names,
          { name, politicalType, borderKind: 'international' },
          keepSubdivisions,
        );
        if (!id) {
          toast('None of those features could be dissolved.', 'error');
        } else {
          toast(`Created "${name}" from ${names.length} features.`, 'success');
          controller?.zoomToFeature(id);
          onClose();
        }
      } else {
        const count = await convertBasemapToTerritories({
          sourceId,
          includeNames: chosen.size ? chosen : undefined,
          includeStateFips: isCounties && stateFilter ? new Set([stateFilter]) : undefined,
          politicalType: divisionType,
          borderKind,
        });
        if (count === 0) toast('Nothing matched that filter.', 'warn');
        else {
          toast(`Imported ${count} editable territories.`, 'success');
          controller?.fitAll();
          onClose();
        }
      }
    } catch (err) {
      toast(`Conversion failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const selectionCount = chosen.size || rows.length;

  return (
    <Dialog
      title="Reference geography → territories"
      onClose={onClose}
      wide
      footer={
        <>
          <span style={{ flex: 1, color: 'var(--text-faint)' }}>
            {features ? `${rows.length} features listed · ${chosen.size || 'all'} selected` : ''}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--accent" disabled={busy || !features || rows.length === 0} onClick={() => void run()}>
            {busy
              ? 'Working…'
              : mode === 'single-state'
                ? `Create "${name}"`
                : `Import ${selectionCount} territories`}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <Field label="Dataset">
            <select className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter by name" />
          </Field>
          {isCounties && (
            <Field label="In state">
              <select className="select" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">— every state —</option>
                {Object.entries(STATE_FIPS)
                  .sort((a, b) => a[1].localeCompare(b[1]))
                  .map(([fips, n]) => (
                    <option key={fips} value={fips}>
                      {n}
                    </option>
                  ))}
              </select>
            </Field>
          )}

          <div
            style={{
              border: '1px solid var(--line)',
              borderRadius: 3,
              maxHeight: 300,
              overflow: 'auto',
              marginTop: 6,
            }}
          >
            {error && <div className="empty" style={{ color: 'var(--danger)' }}>{error}</div>}
            {!features && !error && <div className="empty">Loading…</div>}
            {rows.map((r) => (
              <label
                key={r.name + r.fips}
                className="tree-row"
                style={{ paddingLeft: 7, cursor: 'pointer' }}
                onClick={(e) => {
                  e.preventDefault();
                  toggle(r.name);
                }}
              >
                <input type="checkbox" readOnly checked={chosen.has(r.name)} style={{ accentColor: 'var(--accent)' }} />
                <span className="tree-row__name">{r.name}</span>
                {isCounties && <span className="tree-row__badge">{STATE_FIPS[r.fips] ?? ''}</span>}
              </label>
            ))}
          </div>
          <div className="btn-row" style={{ marginTop: 5 }}>
            <button className="btn" onClick={() => setChosen(new Set(rows.map((r) => r.name)))}>
              Select all listed
            </button>
            <button className="btn" onClick={() => setChosen(new Set())}>
              Clear
            </button>
          </div>
        </div>

        <div>
          <h3 className="panel__section-title">What to create</h3>
          <label className="checkbox" style={{ alignItems: 'flex-start' }}>
            <input type="radio" checked={mode === 'divisions'} onChange={() => setMode('divisions')} style={{ marginTop: 2 }} />
            <span>
              <strong style={{ color: 'var(--text)' }}>One territory per feature</strong>
              <br />
              <span style={{ color: 'var(--text-faint)' }}>
                Each state or county becomes its own editable division. Use the paint tool afterwards
                to group them into realms.
              </span>
            </span>
          </label>
          <label className="checkbox" style={{ alignItems: 'flex-start' }}>
            <input type="radio" checked={mode === 'single-state'} onChange={() => setMode('single-state')} style={{ marginTop: 2 }} />
            <span>
              <strong style={{ color: 'var(--text)' }}>One dissolved state</strong>
              <br />
              <span style={{ color: 'var(--text-faint)' }}>
                Merge the selected features into a single realm, erasing their internal borders.
              </span>
            </span>
          </label>

          {mode === 'single-state' ? (
            <>
              <Field label="Name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Type">
                <select className="select" value={String(politicalType)} onChange={(e) => setPoliticalType(e.target.value)}>
                  {POLITICAL_TYPES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="checkbox">
                <input type="checkbox" checked={keepSubdivisions} onChange={(e) => setKeepSubdivisions(e.target.checked)} />
                Keep the originals as subordinate divisions
              </label>
            </>
          ) : (
            <>
              <Field label="Type">
                <select className="select" value={String(divisionType)} onChange={(e) => setDivisionType(e.target.value)}>
                  {POLITICAL_TYPES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Border">
                <select className="select" value={String(borderKind)} onChange={(e) => setBorderKind(e.target.value)}>
                  {BORDER_HIERARCHY.map((b) => (
                    <option key={String(b.kind)} value={String(b.kind)}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}

          <p className="hint">
            The document currently holds {Object.keys(project.territories).length} territories.
            Importing thousands of counties at once is supported but will make editing heavier —
            filter to the region you need.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

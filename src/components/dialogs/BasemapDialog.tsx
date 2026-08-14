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
  findBasemapSource,
  linesOf,
  loadBasemap,
  pointsOf,
  polygonsOf,
  type BasemapFeature,
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
  const [features, setFeatures] = useState<BasemapFeature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [namedOnly, setNamedOnly] = useState(true);
  const [mode, setMode] = useState<Mode>('divisions');
  const [name, setName] = useState('New Kingdom');
  const [politicalType, setPoliticalType] = useState<PoliticalType>('kingdom');
  const [divisionType, setDivisionType] = useState<PoliticalType>('province');
  const [borderKind, setBorderKind] = useState<BorderStyleKind>('provincial');
  const [keepSubdivisions, setKeepSubdivisions] = useState(true);
  const [snapToCoast, setSnapToCoast] = useState(true);
  const [busy, setBusy] = useState(false);

  const isCounties = sourceId === 'us-counties';
  const role = findBasemapSource(sourceId)?.role;
  const isRivers = role === 'rivers';
  const isLakes = role === 'lakes';
  const isPlaces = role === 'places';
  /**
   * Trimming to the coast is only meaningful for land divisions. A lake is
   * water by definition and would be trimmed out of existence; rivers and
   * cities are not areas at all.
   */
  const snapsToCoast = !isRivers && !isLakes && !isPlaces;
  /** Only areal datasets can be merged into a realm. */
  const dissolvable = !isRivers && !isPlaces;
  const noun = isRivers
    ? { one: 'river', many: 'rivers' }
    : isLakes
      ? { one: 'lake', many: 'lakes' }
      : isPlaces
        ? { one: 'city', many: 'cities' }
        : { one: 'territory', many: 'territories' };

  // "Dissolve into one state" is meaningless for centrelines and city points.
  useEffect(() => {
    if (!dissolvable && mode === 'single-state') setMode('divisions');
  }, [dissolvable, mode]);

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

  /**
   * The converter filters by position within the dataset's own kind, so index
   * here means "nth polygon" or "nth line" — never the raw feature index, which
   * would be wrong for a mixed file.
   */
  const candidates = useMemo(
    () =>
      features
        ? isRivers
          ? linesOf(features)
          : isPlaces
            ? pointsOf(features)
            : polygonsOf(features)
        : [],
    [features, isRivers, isPlaces],
  );

  const unnamedCount = useMemo(
    () => candidates.filter((f) => basemapFeatureName(f) === 'Unnamed').length,
    [candidates],
  );

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const listed = candidates
      .map((f, index) => {
        const props = (f.properties ?? {}) as Record<string, unknown>;
        return {
          index,
          name: basemapFeatureName(f),
          fips: typeof f.id === 'number' || typeof f.id === 'string' ? String(f.id).padStart(5, '0').slice(0, 2) : '',
          // Cities carry their country, which is the only way to tell the
          // several dozen Springfields and Victorias apart in the list.
          badge: isPlaces ? String(props.adm0name ?? '') : '',
          rank: isPlaces ? Number(props.scalerank ?? 10) : 0,
        };
      })
      .filter((r) => (namedOnly ? r.name !== 'Unnamed' : true))
      .filter((r) => (q ? r.name.toLowerCase().includes(q) || r.badge.toLowerCase().includes(q) : true))
      .filter((r) => (isCounties && stateFilter ? r.fips === stateFilter : true));
    // Seven thousand cities sorted alphabetically buries every capital, so rank
    // them by Natural Earth's scalerank first — world cities, then the rest.
    return isPlaces
      ? listed.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.index - b.index)
      : listed.sort((a, b) => a.name.localeCompare(b.name) || a.index - b.index);
  }, [candidates, filter, stateFilter, isCounties, isPlaces, namedOnly]);

  const toggle = (index: number) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const run = async () => {
    setBusy(true);
    try {
      if (mode === 'single-state') {
        const names = (chosen.size ? rows.filter((r) => chosen.has(r.index)) : rows).map((r) => r.name);
        const id = await territoryFromBasemapFeatures(
          sourceId,
          names,
          { name, politicalType, borderKind: 'international' },
          keepSubdivisions,
          snapsToCoast && snapToCoast,
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
          // Selecting nothing means "everything currently listed", which is what
          // the button label promises.
          includeIndices: new Set((chosen.size ? rows.filter((r) => chosen.has(r.index)) : rows).map((r) => r.index)),
          includeStateFips: isCounties && stateFilter ? new Set([stateFilter]) : undefined,
          politicalType: divisionType,
          borderKind,
          snapToCoast: snapsToCoast && snapToCoast,
        });
        if (count === 0) toast('Nothing matched that filter.', 'warn');
        else {
          toast(
            `Imported ${count} ${count === 1 ? noun.one : noun.many}` +
              (isLakes ? ' as water bodies.' : '.'),
            'success',
          );
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
                : `Import ${selectionCount} ${selectionCount === 1 ? noun.one : noun.many}`}
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
                // Keyed by dataset index: names are not unique — Natural Earth has
                // hundreds of "Unnamed" lakes and several real "Trout Lake"s, and
                // duplicate React keys leave stale rows behind.
                key={r.index}
                className="tree-row"
                style={{ paddingLeft: 7, cursor: 'pointer' }}
                onClick={(e) => {
                  e.preventDefault();
                  toggle(r.index);
                }}
              >
                <input type="checkbox" readOnly checked={chosen.has(r.index)} style={{ accentColor: 'var(--accent)' }} />
                <span className="tree-row__name">{r.name}</span>
                {isCounties && <span className="tree-row__badge">{STATE_FIPS[r.fips] ?? ''}</span>}
                {isPlaces && r.badge && <span className="tree-row__badge">{r.badge}</span>}
              </label>
            ))}
          </div>
          {unnamedCount > 0 && (
            <label className="checkbox" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={namedOnly} onChange={(e) => setNamedOnly(e.target.checked)} />
              Hide unnamed features ({unnamedCount.toLocaleString()})
            </label>
          )}
          <div className="btn-row" style={{ marginTop: 5 }}>
            <button className="btn" onClick={() => setChosen(new Set(rows.map((r) => r.index)))}>
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
              <strong style={{ color: 'var(--text)' }}>
                {isRivers
                  ? 'One river per feature'
                  : isLakes
                    ? 'One water body per lake'
                    : isPlaces
                      ? 'One settlement per city'
                      : 'One territory per feature'}
              </strong>
              <br />
              <span style={{ color: 'var(--text-faint)' }}>
                {isRivers
                  ? 'Each becomes an editable river you can reshape, rename and relabel. Names run along the river automatically.'
                  : isLakes
                    ? 'Each lake becomes an editable water body using the Water style, with its name as a water label.'
                    : isPlaces
                      ? 'Each city becomes an editable settlement with its own symbol, population and label, owned by whichever territory it falls inside.'
                      : 'Each state or county becomes its own editable division. Use the paint tool afterwards to group them into realms.'}
              </span>
            </span>
          </label>
          {dissolvable && (
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
          )}

          {snapsToCoast && (
            <label className="checkbox" style={{ alignItems: 'flex-start', marginTop: 8 }}>
              <input
                type="checkbox"
                checked={snapToCoast}
                onChange={(e) => setSnapToCoast(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong style={{ color: 'var(--text)' }}>Trim to the coastline</strong>
                <br />
                <span style={{ color: 'var(--text-faint)' }}>
                  Administrative boundaries are drawn to their own tolerance, not the coastline's —
                  the Census file describes all of Massachusetts in 155 points and covers 420 km² of
                  open sea doing it. Trimming puts each seaward edge on the shore itself. Inland
                  divisions are left exactly as they came.
                </span>
              </span>
            </label>
          )}

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
            isRivers || isLakes || isPlaces ? (
              <p className="hint">
                {isRivers
                  ? 'Rivers come in ranked by Natural Earth\'s scalerank, so major rivers get the heavier line style.'
                  : isLakes
                    ? 'Lakes come in with the Water style class, so they match the ocean colour and update with it.'
                    : 'Natural Earth marks which cities are national and regional capitals, so each one arrives with the right symbol; population and country come across too.'}
              </p>
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
            )
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

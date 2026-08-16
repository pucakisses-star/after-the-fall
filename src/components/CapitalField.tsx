/**
 * Naming a territory's capital by typing it (spec §7, §47).
 *
 * A dropdown of the document's settlements is the wrong shape for this question.
 * On a map of any size it is hundreds of entries long and, worse, it can only
 * offer towns the document already has — so naming a realm's seat after a city
 * that exists on the reference layer, or after one that exists nowhere at all,
 * meant leaving the inspector, finding the place, adopting it and coming back.
 *
 * Typing is the right shape, and it searches three things at once: the
 * settlements the map already carries, the four thousand real places on the
 * reference layer, and — last, and only when nothing matched — the name you
 * typed, offered as a town to invent. Choosing from the second adopts the place
 * into the document on the way past; choosing the third puts a new town in the
 * middle of the country. Either way one press of undo takes it back.
 *
 * Places inside the territory rank above places outside it, which is what makes
 * the list usable: a hundred towns share a name across a continent, and the one
 * meant is nearly always the one on this ground.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { loadBasemap, pointsOf } from '@/geo/basemap';
import { setCapital, territoryContains, type CapitalChoice, type ReferencePlace } from '@/state/commands';
import { useProjectStore } from '@/state/projectStore';
import type { Territory } from '@/model/types';

/** How many suggestions are worth showing. Beyond this, type more. */
const MAX_SUGGESTIONS = 12;

interface Suggestion {
  key: string;
  name: string;
  detail: string;
  kind: string;
  choice: CapitalChoice;
  score: number;
}

// The gazetteer is a 1.5 MB download shared with the reference layer, so it is
// fetched once, on the first keystroke that could want it, and kept.
let gazetteer: ReferencePlace[] | null = null;
let gazetteerLoad: Promise<ReferencePlace[]> | null = null;

function loadGazetteer(): Promise<ReferencePlace[]> {
  if (gazetteer) return Promise.resolve(gazetteer);
  gazetteerLoad ??= loadBasemap('world-places-10m')
    .then((features) => {
      const out: ReferencePlace[] = [];
      for (const f of pointsOf(features)) {
        const name = f.properties?.name;
        if (typeof name !== 'string' || !name) continue;
        const at = f.geometry.type === 'Point' ? f.geometry.coordinates : f.geometry.coordinates[0];
        if (!at || at.length < 2) continue;
        const pop = Number(f.properties?.pop_max);
        out.push({
          name,
          coordinates: [at[0], at[1]],
          scalerank: Number(f.properties?.scalerank),
          ...(Number.isFinite(pop) && pop > 0 ? { population: pop } : {}),
        });
      }
      gazetteer = out;
      return out;
    })
    // A missing reference file is not a reason for the field to stop working;
    // it just means the document's own settlements are all it can offer.
    .catch(() => []);
  return gazetteerLoad;
}

const round = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

export function CapitalField({ territory }: { territory: Territory }) {
  const project = useProjectStore((s) => s.project);
  const capital = territory.capitalId ? project.settlements[territory.capitalId] : null;

  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [places, setPlaces] = useState<ReferencePlace[]>(gazetteer ?? []);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Only while the field is being typed in — the download is not worth making
  // for a panel nobody has touched.
  useEffect(() => {
    if (query === null || gazetteer) return;
    let live = true;
    void loadGazetteer().then((p) => live && setPlaces(p));
    return () => {
      live = false;
    };
  }, [query]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setQuery(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const suggestions = useMemo<Suggestion[]>(() => {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return [];
    const out: Suggestion[] = [];

    // Prefix matches first, then matches inside the territory, then the bigger
    // place — which between two towns of a name is the one people mean.
    const rank = (name: string, at: [number, number], population: number | undefined, base: number) => {
      const index = name.toLowerCase().indexOf(q);
      if (index < 0) return null;
      const here = territoryContains(territory, at) ? 0 : 400;
      return base + here + (index === 0 ? 0 : 200) + index - Math.min(150, Math.log10((population ?? 1) + 1) * 25);
    };

    const taken = new Set<string>();
    for (const s of Object.values(project.settlements)) {
      const at = s.geometry.coordinates as [number, number];
      const score = rank(s.name, at, s.population ?? undefined, 0);
      if (score === null) continue;
      taken.add(`${s.name.trim().toLowerCase()}|${at[0].toFixed(3)}|${at[1].toFixed(3)}`);
      out.push({
        key: s.id,
        name: s.name,
        detail: s.population ? `${round(s.population)} people` : String(s.type).replace(/-/g, ' '),
        kind: 'on the map',
        choice: { kind: 'settlement', id: s.id },
        score,
      });
    }

    for (const p of places) {
      // A place the document has already adopted is offered once, as its own
      // settlement — the entry above.
      if (taken.has(`${p.name.trim().toLowerCase()}|${p.coordinates[0].toFixed(3)}|${p.coordinates[1].toFixed(3)}`)) {
        continue;
      }
      const score = rank(p.name, p.coordinates, p.population, 50);
      if (score === null) continue;
      out.push({
        key: `place:${p.name}:${p.coordinates.join(',')}`,
        name: p.name,
        detail: p.population ? `${round(p.population)} people` : 'reference city',
        kind: 'reference',
        choice: { kind: 'place', place: p },
        score,
      });
    }

    out.sort((a, b) => a.score - b.score);
    const top = out.slice(0, MAX_SUGGESTIONS);

    // Inventing one is always available, but never above a real match: it is the
    // answer when the map has never heard of the name, not the first guess.
    if (!top.some((s) => s.name.toLowerCase() === q)) {
      top.push({
        key: 'new',
        name: (query ?? '').trim(),
        detail: `a new town in ${territory.name}`,
        kind: 'invent',
        choice: { kind: 'new', name: (query ?? '').trim() },
        score: Infinity,
      });
    }
    return top;
  }, [query, places, project.settlements, territory]);

  const choose = (choice: CapitalChoice) => {
    setCapital(territory.id, choice);
    setQuery(null);
  };

  return (
    <div className="combo" ref={boxRef}>
      <input
        className="input"
        placeholder="type a city…"
        value={query ?? capital?.name ?? ''}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        // The seat it already has, selected, so typing replaces it and looking
        // does not erase it. Clearing the box and pressing Enter is how a realm
        // gives up having one.
        onFocus={(e) => {
          setQuery(capital?.name ?? '');
          e.target.select();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, suggestions.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            // An emptied field means the realm has no capital, which is a
            // perfectly ordinary thing for it not to have.
            if (!(query ?? '').trim()) choose({ kind: 'none' });
            else if (suggestions[active]) choose(suggestions[active].choice);
          } else if (e.key === 'Escape') {
            setQuery(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {query !== null && query.trim() !== '' && (
        <div className="search__results">
          {suggestions.map((s, i) => (
            <div
              key={s.key}
              className={`search__item${i === active ? ' search__item--active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(s.choice)}
            >
              <span>{s.name}</span>
              <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>{s.detail}</span>
              <span className="search__kind">{s.kind}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Search (spec §37). Finds territories, settlements, rivers, roads and labels. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { useMapController } from './MapContext';
import { IconSearch } from './icons';
import type { UUID } from '@/model/types';

interface Result {
  id: UUID;
  name: string;
  kind: string;
  detail: string;
  score: number;
}

export function SearchBox() {
  const project = useProjectStore((s) => s.project);
  const controller = useMapController();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 1) return [];
    const out: Result[] = [];

    const consider = (id: UUID, name: string, kind: string, detail: string) => {
      const lower = name.toLowerCase();
      const index = lower.indexOf(q);
      if (index < 0) return;
      // Prefix matches rank above substring matches; shorter names above longer.
      out.push({ id, name, kind, detail, score: (index === 0 ? 0 : 100) + index + name.length * 0.1 });
    };

    for (const t of Object.values(project.territories)) {
      consider(t.id, t.name, 'territory', String(t.politicalType).replace(/-/g, ' '));
    }
    for (const s of Object.values(project.settlements)) {
      consider(s.id, s.name, 'settlement', String(s.type).replace(/-/g, ' '));
    }
    for (const f of Object.values(project.linearFeatures)) {
      consider(f.id, f.name, f.kind.startsWith('river') ? 'river' : 'road', String(f.kind).replace(/-/g, ' '));
    }
    for (const l of Object.values(project.labels)) {
      // Skip labels that merely echo their owner's name — they add noise.
      const owner = l.attachedToId;
      if (owner && (project.territories[owner]?.name === l.text || project.settlements[owner]?.name === l.text)) {
        continue;
      }
      consider(l.id, l.text, 'label', l.kind);
    }

    out.sort((a, b) => a.score - b.score);
    return out.slice(0, 40);
  }, [query, project]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Ctrl/Cmd+F focuses the box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choose = (r: Result) => {
    useUIStore.getState().setSelection([r.id]);
    controller?.zoomToFeature(r.id);
    setOpen(false);
  };

  return (
    <div className="search" ref={boxRef}>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 6, top: 5, color: 'var(--text-faint)' }}>
          <IconSearch />
        </span>
        <input
          ref={inputRef}
          className="input"
          style={{ paddingLeft: 24 }}
          placeholder="Search the map…  (Ctrl+F)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => query && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && results[active]) {
              e.preventDefault();
              choose(results[active]);
            } else if (e.key === 'Escape') {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
      {open && query.trim() && (
        <div className="search__results">
          {results.length === 0 && <div className="search__item">No matches.</div>}
          {results.map((r, i) => (
            <div
              key={r.id}
              className={`search__item${i === active ? ' search__item--active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <span>{r.name}</span>
              <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>{r.detail}</span>
              <span className="search__kind">{r.kind}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

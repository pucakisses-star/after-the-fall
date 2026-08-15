import { createProject } from './src/model/project';
import { inheritedFill } from './src/model/resolveStyle';
import { colorDistance } from './src/model/color';
import type { Territory } from './src/model/types';

const p = createProject({ title: 'x' });
const base = '#d99b9b';
const mk = (id: string, rel: string): Territory => ({
  id, layerId: 'l', name: id, shortName: '', politicalType: 'province',
  relationship: rel as never, parentId: 'realm', liegeId: null, capitalId: null,
  notes: '', locked: false, hidden: false, timeline: { start: null, end: null },
  geometry: { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] },
  styleClassId: 'sc', styleOverrides: {}, inheritParentColor: true,
  borderKind: 'provincial', labelId: null,
});
p.territories['realm'] = { ...mk('realm', 'sovereign'), parentId: null, inheritParentColor: false,
  styleOverrides: { fillColor: base } } as Territory;

for (const rel of ['sovereign', 'constituent', 'vassal']) {
  const ids = ['Alpha', 'Beta', 'Gamma'].map((n) => { const t = mk(n, rel); p.territories[n] = t; return t; });
  const fills = ids.map((t) => inheritedFill(p, t)!);
  console.log(rel.padEnd(12), fills.join(' '),
    '| dist from realm:', fills.map((f) => colorDistance(f, base).toFixed(1)).join(', '));
}

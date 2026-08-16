import { readFileSync, writeFileSync } from 'fs';
const topo = JSON.parse(readFileSync('public/data/us/counties-10m.json', 'utf8'));
const NE = ['23','33','50','25','09','44','36','34','42','10','24','11','51','54'];
const byArc = new Map();
const fipsOf = (g) => String(g.id).padStart(5, '0');
const walk = (arcs, cb) => { for (const a of arcs) Array.isArray(a) ? walk(a, cb) : cb(a < 0 ? ~a : a); };
for (const g of topo.objects.counties.geometries) {
  const f = fipsOf(g);
  if (!NE.includes(f.slice(0, 2))) continue;
  walk(g.arcs, (a) => {
    if (!byArc.has(a)) byArc.set(a, new Set());
    byArc.get(a).add(f);
  });
}
const adj = {};
for (const owners of byArc.values()) {
  const list = [...owners];
  for (const x of list) for (const y of list) {
    if (x === y) continue;
    (adj[x] ??= new Set()).add(y);
  }
}
const out = Object.fromEntries(Object.entries(adj).map(([k, v]) => [k, [...v]]));
writeFileSync('/tmp/claude-0/-home-user-after-the-fall/7273de68-bbdc-549e-aa27-0ef51bf1250c/scratchpad/ne-adj.json', JSON.stringify(out));
console.log('adjacency for', Object.keys(out).length, 'counties;',
  Object.values(out).reduce((n, v) => n + v.length, 0) / 2, 'edges');

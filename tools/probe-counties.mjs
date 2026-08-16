import { readFileSync } from 'fs';
import { feature } from 'topojson-client';
const topo = JSON.parse(readFileSync('public/data/us/counties-10m.json', 'utf8'));
const fc = feature(topo, topo.objects.counties);
const NE = { '23':'ME','33':'NH','50':'VT','25':'MA','09':'CT','44':'RI','36':'NY','34':'NJ','42':'PA','10':'DE','24':'MD','11':'DC','51':'VA','54':'WV' };
const picked = fc.features.filter((f) => NE[String(f.id).padStart(5,'0').slice(0,2)]);
const byState = {};
let verts = 0;
for (const f of picked) {
  const st = NE[String(f.id).padStart(5,'0').slice(0,2)];
  byState[st] = (byState[st] ?? 0) + 1;
  const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
  for (const r of rings) verts += r.length;
}
console.log('counties in the northeast:', picked.length);
console.log(Object.entries(byState).map(([k,v]) => `${k}:${v}`).join('  '));
console.log('total vertices:', verts.toLocaleString());
const asJson = JSON.stringify(picked.map((f) => f.geometry));
console.log('geometry as JSON:', (asJson.length/1e6).toFixed(2), 'MB');
const trimmed = JSON.stringify(JSON.parse(asJson, (k,v) => typeof v === 'number' ? Math.round(v*1e4)/1e4 : v));
console.log('at 4dp (~11 m):     ', (trimmed.length/1e6).toFixed(2), 'MB');

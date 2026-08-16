import { readFileSync, writeFileSync } from 'fs';
import { feature } from 'topojson-client';
const topo = JSON.parse(readFileSync('public/data/us/counties-10m.json', 'utf8'));
const fc = feature(topo, topo.objects.counties);
const NE = ['23','33','50','25','09','44','36','34','42','10','24','11','51','54'];
const out = [];
for (const f of fc.features) {
  const st = String(f.id).padStart(5,'0').slice(0,2);
  if (!NE.includes(st)) continue;
  out.push({ id: String(f.id).padStart(5,'0'), name: f.properties?.name ?? '', geometry: f.geometry });
}
writeFileSync('/tmp/claude-0/-home-user-after-the-fall/7273de68-bbdc-549e-aa27-0ef51bf1250c/scratchpad/ne-counties.json', JSON.stringify(out));
console.log('exported', out.length, 'northeast counties');

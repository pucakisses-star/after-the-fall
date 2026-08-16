import { readFileSync, writeFileSync } from 'fs';
import { feature } from 'topojson-client';
const out = {};
for (const [key, file, obj] of [['land','public/data/world/land-10m.json','land'],
                                ['lakes','public/data/world/lakes-10m.json','lakes']]) {
  const topo = JSON.parse(readFileSync(file, 'utf8'));
  const name = topo.objects[obj] ? obj : Object.keys(topo.objects)[0];
  const fc = feature(topo, topo.objects[name]);
  const polys = [];
  for (const f of fc.features) {
    const g = f.geometry; if (!g) continue;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
  }
  // Only what could be on the plate, to keep the file small.
  const near = polys.filter((rings) => rings[0].some(([x,y]) => x > -120 && x < -55 && y > 20 && y < 60));
  out[key] = near;
  console.log(key, ':', polys.length, 'parts →', near.length, 'near the plate');
}
writeFileSync('/tmp/claude-0/-home-user-after-the-fall/7273de68-bbdc-549e-aa27-0ef51bf1250c/scratchpad/water.json', JSON.stringify(out));

/**
 * SVG export (spec §48, §66).
 *
 * This is a real vector serialiser, not a canvas dump. It walks the document and
 * writes SVG primitives, so:
 *
 *   • polygons stay `<path>`, borders stay `<path>`, symbols stay shapes
 *   • text stays `<text>` — never outlined, never rasterised (§66)
 *   • tracking becomes `letter-spacing`, halos become `paint-order="stroke"`
 *   • hatch fills become `<pattern>` defs built from the same description the
 *     canvas renderer uses (§9, §45)
 *   • groups are named and ordered exactly as §66 specifies, so the file opens
 *     in Illustrator or Inkscape with a sane layer structure
 */

import proj4 from 'proj4';
import { clipToValidArea, findBasemapSource, isPolygonFeature, loadBasemap } from '@/geo/basemap';
import { registerProjections, renderExtentFor } from '@/geo/projections';
import { computeBorders } from '@/render/borders';
import { svgPatternDef, svgPatternId, dashArray, doubleLineWidths, isDoubleLine } from '@/render/patterns';
import {
  PLACE_DOT_FILL,
  PLACE_DOT_STROKE,
  PLACE_TEXT_FILL,
  PLACE_TEXT_HALO,
  metersPerUnit,
  placeDotVisible,
  placeLabelVisible,
  placeRankStyle,
  riverRankStyle,
} from '@/render/olStyles';
import { symbolToSvg } from '@/render/symbols';
import { toCss } from '@/model/color';
import { STYLE_IDS } from '@/model/defaults';
import { layerEffective } from '@/model/hierarchy';
import { visibleInTime } from '@/model/timeline';
import {
  applyTextTransform,
  resolveLinearStyle,
  resolveSymbolStyle,
  resolveTerritoryStyle,
  resolveTextStyle,
} from '@/model/resolveStyle';
import type { HatchPattern, LineStyle, MapProject, TextStyle, UUID } from '@/model/types';
import type { LineString, MultiLineString, MultiPolygon, Polygon, Position } from 'geojson';

export interface SvgExportOptions {
  width: number;
  height: number;
  /** Geographic extent to render, in WGS84 [minLon, minLat, maxLon, maxLat]. */
  extent: [number, number, number, number];
  /** Multiplier applied to every stroke width and font size. */
  styleScale: number;
  background: boolean;
  includeBasemap: boolean;
  includeGraticule: boolean;
  graticuleInterval: number;
  includeFrame: boolean;
  frameStyle: 'simple' | 'double' | 'coordinate-blocks';
  includeTitle: boolean;
  includeScaleBar: boolean;
  /** Margin reserved for the frame, in output px. */
  margin: number;
}

export const DEFAULT_SVG_OPTIONS: Omit<SvgExportOptions, 'extent' | 'width' | 'height'> = {
  styleScale: 1,
  background: true,
  includeBasemap: true,
  includeGraticule: false,
  graticuleInterval: 5,
  includeFrame: true,
  frameStyle: 'double',
  includeTitle: false,
  includeScaleBar: false,
  margin: 28,
};

/** lon/lat → output pixel. */
type Projector = (lon: number, lat: number) => [number, number] | null;

interface Frame {
  /** Inner drawing area. */
  x: number;
  y: number;
  w: number;
  h: number;
}

function buildProjector(
  project: MapProject,
  opts: SvgExportOptions,
): { project: Projector; frame: Frame; resolution: number } {
  registerProjections();
  const code = project.projection.id;
  const forward =
    code === 'EPSG:4326'
      ? (lon: number, lat: number): [number, number] => [lon, lat]
      : (() => {
          const tx = proj4('EPSG:4326', code);
          return (lon: number, lat: number): [number, number] => {
            const out = tx.forward([lon, lat]) as [number, number];
            return out;
          };
        })();

  const m = opts.includeFrame ? opts.margin : 0;
  const frame: Frame = { x: m, y: m, w: opts.width - m * 2, h: opts.height - m * 2 };

  // Project the requested extent's corners and edges to find the projected box.
  // Edges are sampled because most projections curve the parallels.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const [w0, s0, e0, n0] = opts.extent;
  const steps = 32;
  const consider = (lon: number, lat: number) => {
    try {
      const [x, y] = forward(lon, lat);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    } catch {
      /* outside the projection domain */
    }
  };
  for (let i = 0; i <= steps; i++) {
    const fx = i / steps;
    consider(w0 + (e0 - w0) * fx, s0);
    consider(w0 + (e0 - w0) * fx, n0);
    consider(w0, s0 + (n0 - s0) * fx);
    consider(e0, s0 + (n0 - s0) * fx);
  }
  if (!Number.isFinite(minX)) {
    minX = w0;
    maxX = e0;
    minY = s0;
    maxY = n0;
  }

  // Fit the projected box into the frame, preserving aspect ratio.
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);
  const scale = Math.min(frame.w / spanX, frame.h / spanY);
  const offsetX = frame.x + (frame.w - spanX * scale) / 2;
  const offsetY = frame.y + (frame.h - spanY * scale) / 2;

  const projector: Projector = (lon, lat) => {
    try {
      const [x, y] = forward(lon, lat);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      // SVG y grows downwards, so flip.
      return [offsetX + (x - minX) * scale, offsetY + (maxY - y) * scale];
    } catch {
      return null;
    }
  };

  // Projected units per output pixel — the same quantity OpenLayers calls a
  // resolution, so the exporter can apply the screen's zoom-dependent rules
  // (which reference cities get named, for instance) and reach the same answer.
  return { project: projector, frame, resolution: 1 / scale };
}

// ---------------------------------------------------------------------------
// Path construction
// ---------------------------------------------------------------------------

function ringToPath(ring: Position[], p: Projector): string {
  let d = '';
  let started = false;
  for (const [lon, lat] of ring) {
    const pt = p(lon, lat);
    if (!pt) continue;
    d += `${started ? 'L' : 'M'}${num(pt[0])} ${num(pt[1])}`;
    started = true;
  }
  return started ? `${d}Z` : '';
}

function polygonToPath(g: Polygon | MultiPolygon, p: Projector): string {
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  return rings.map((r) => ringToPath(r, p)).join('');
}

function lineToPath(g: LineString | MultiLineString, p: Projector): string {
  const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
  let d = '';
  for (const line of lines) {
    let started = false;
    for (const [lon, lat] of line) {
      const pt = p(lon, lat);
      if (!pt) continue;
      d += `${started ? 'L' : 'M'}${num(pt[0])} ${num(pt[1])}`;
      started = true;
    }
  }
  return d;
}

/** The first coordinate of a point (or multi-point) reference feature. */
function firstPointOf(f: { geometry: { type: string; coordinates: unknown } }, p: Projector) {
  const g = f.geometry;
  const c =
    g.type === 'Point' ? (g.coordinates as Position)
    : g.type === 'MultiPoint' ? (g.coordinates as Position[])[0]
    : null;
  return c ? p(c[0], c[1]) : null;
}

function num(n: number): string {
  return Math.abs(n) < 1e-4 ? '0' : n.toFixed(2);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Style → SVG attributes
// ---------------------------------------------------------------------------

function strokeAttrs(s: LineStyle, scale: number): string {
  const dash = dashArray(s.dash, s.width * scale);
  return (
    `stroke="${toCss(s.color, s.opacity)}" stroke-width="${num(Math.max(0.05, s.width * scale))}" ` +
    `stroke-linecap="${s.lineCap}" stroke-linejoin="${s.lineJoin}" fill="none"` +
    (dash ? ` stroke-dasharray="${dash.map((d) => num(d)).join(' ')}"` : '')
  );
}

function textAttrs(s: TextStyle, scale: number): string {
  const anchor = s.align === 'left' ? 'start' : s.align === 'right' ? 'end' : 'middle';
  let attrs =
    `font-family="${esc(s.fontFamily)}" font-size="${num(s.fontSize * scale)}" ` +
    `font-weight="${s.fontWeight}" fill="${toCss(s.color, s.opacity)}" ` +
    `text-anchor="${anchor}" letter-spacing="${num(s.tracking * scale)}"`;
  if (s.italic) attrs += ' font-style="italic"';
  // paint-order keeps the halo behind the glyph rather than eroding it.
  if (s.haloColor && s.haloWidth > 0) {
    attrs += ` paint-order="stroke" stroke="${toCss(s.haloColor, 1)}" stroke-width="${num(s.haloWidth * 2 * scale)}" stroke-linejoin="round"`;
  } else if (s.outlineColor && s.outlineWidth > 0) {
    attrs += ` paint-order="stroke" stroke="${toCss(s.outlineColor, 1)}" stroke-width="${num(s.outlineWidth * scale)}"`;
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function exportSvg(project: MapProject, opts: SvgExportOptions): Promise<string> {
  const { project: p, frame, resolution } = buildProjector(project, opts);
  const scale = opts.styleScale;
  const metersPerPixel = resolution * metersPerUnit(project.projection.units);

  const patterns = new Map<string, HatchPattern>();
  const defs: string[] = [];
  const groups: string[] = [];

  // --- water / background ---------------------------------------------------
  const water: string[] = [];
  if (opts.background) {
    water.push(
      `<rect x="${num(frame.x)}" y="${num(frame.y)}" width="${num(frame.w)}" height="${num(frame.h)}" fill="${project.oceanColor}"/>`,
    );
  }
  groups.push(group('water', water));

  // --- basemap land ---------------------------------------------------------
  const terrain: string[] = [];
  const basemapRivers: string[] = [];
  const basemapPlaces: string[] = [];
  const lakeLayers: string[] = [];
  if (opts.includeBasemap) {
    // Match the screen's draw order: land, then lakes, then everything else.
    // Rivers are collected separately so they land in the §66 "rivers" group
    // rather than being buried in "terrain".
    const ordered = [...project.basemap].filter((b) => b.visible).sort((a, b) => {
      const rank = (id: string) => {
        const role = findBasemapSource(id)?.role;
        return role === 'land' ? 0 : role === 'lakes' ? 1 : 2;
      };
      return rank(a.sourceId) - rank(b.sourceId);
    });

    for (const entry of ordered) {
      try {
        const all = await loadBasemap(entry.sourceId);
        // Same domain clipping as the screen, so the export matches it.
        const valid = renderExtentFor(project.projection.id, project.workingExtent);
        const features = all
          .map((f) => clipToValidArea(f, valid))
          .filter((f): f is NonNullable<typeof f> => f !== null);
        const role = findBasemapSource(entry.sourceId)?.role ?? 'custom';

        if (role === 'rivers') {
          // Bucket by importance so trunk rivers export heavier than tributaries,
          // exactly as they render on screen. Grouping by rank also keeps the
          // markup small: one <g> per weight instead of per river.
          const byRank = new Map<number, string[]>();
          for (const f of features) {
            if (isPolygonFeature(f)) continue;
            const d = lineToPath(f.geometry as LineString | MultiLineString, p);
            if (!d) continue;
            const raw = Number((f.properties as Record<string, unknown> | undefined)?.scalerank);
            const rank = Number.isFinite(raw) ? Math.max(0, Math.min(11, Math.round(raw))) : 9;
            const bucket = byRank.get(rank);
            if (bucket) bucket.push(`<path d="${d}"/>`);
            else byRank.set(rank, [`<path d="${d}"/>`]);
          }
          if (byRank.size) {
            // Minor first, so major rivers land on top where they cross.
            const inner = [...byRank.entries()]
              .sort((a, b) => b[0] - a[0])
              .map(([rank, paths]) => {
                const { width, color } = riverRankStyle(rank);
                return (
                  `<g stroke="${color}" stroke-width="${num(width * scale)}">${paths.join('')}</g>`
                );
              })
              .join('');
            basemapRivers.push(
              `<g id="basemap-${esc(entry.sourceId)}" fill="none" stroke-linecap="round" ` +
                `stroke-linejoin="round" opacity="${entry.opacity}">${inner}</g>`,
            );
          }
          continue;
        }

        if (role === 'places') {
          // Reference cities are points, and they belong with the settlements
          // rather than in "terrain". Both the dot size and which names survive
          // come from the shared helpers the screen renderer uses, so a printed
          // map names the same cities the editor did.
          const dots: string[] = [];
          const names: string[] = [];
          for (const f of features) {
            const pt = firstPointOf(f, p);
            if (!pt) continue;
            const props = (f.properties ?? {}) as Record<string, unknown>;
            if (!placeDotVisible(Number(props.scalerank), metersPerPixel)) continue;
            const { radius, fontSize } = placeRankStyle(Number(props.scalerank));
            const r = radius * scale;
            dots.push(`<circle cx="${num(pt[0])}" cy="${num(pt[1])}" r="${num(r)}"/>`);
            const name = typeof props.name === 'string' ? props.name : '';
            if (!name || !placeLabelVisible(Number(props.labelrank), metersPerPixel)) continue;
            names.push(
              `<text x="${num(pt[0] + r + 4 * scale)}" y="${num(pt[1] + fontSize * 0.35 * scale)}"` +
                (fontSize === 10 ? '' : ` font-size="${num(fontSize * scale)}"`) +
                `>${esc(name)}</text>`,
            );
          }
          if (dots.length) {
            basemapPlaces.push(
              `<g id="basemap-${esc(entry.sourceId)}" opacity="${entry.opacity}">` +
                `<g fill="${PLACE_DOT_FILL}" stroke="${PLACE_DOT_STROKE}" stroke-width="${num(scale)}">` +
                `${dots.join('')}</g>` +
                (names.length
                  ? `<g font-family="'Iowan Old Style', Palatino, Georgia, serif" ` +
                    `font-size="${num(10 * scale)}" fill="${PLACE_TEXT_FILL}" ` +
                    `paint-order="stroke" stroke="${PLACE_TEXT_HALO}" stroke-width="${num(2.5 * scale)}" ` +
                    `stroke-linejoin="round">${names.join('')}</g>`
                  : '') +
                `</g>`,
            );
          }
          continue;
        }

        const fill =
          role === 'land' ? project.landColor : role === 'lakes' ? project.oceanColor : 'none';
        const stroke = role === 'land' ? '#8b7f6a' : role === 'lakes' ? '#7d9bad' : '#a89c86';
        const width = (role === 'land' ? 0.8 : role === 'lakes' ? 0.6 : 0.4) * scale;

        const paths: string[] = [];
        for (const f of features) {
          if (!isPolygonFeature(f)) continue;
          const d = polygonToPath(f.geometry as Polygon | MultiPolygon, p);
          if (d) paths.push(`<path d="${d}"/>`);
        }
        if (paths.length) {
          const markup =
            `<g id="basemap-${esc(entry.sourceId)}" fill="${fill}" stroke="${stroke}" ` +
            `stroke-width="${num(width)}" fill-rule="evenodd" opacity="${entry.opacity}">${paths.join('')}</g>`;
          (role === 'lakes' ? lakeLayers : terrain).push(markup);
        }
      } catch {
        /* a basemap that will not load simply does not appear in the export */
      }
    }
  }
  groups.push(group('terrain', terrain));
  // `waterOverlay` holds the lakes that belong above the political fills; it is
  // emitted after the territories group below, mirroring the screen.
  const waterOverlay = lakeLayers;

  // --- territories ----------------------------------------------------------
  const territories: string[] = [];
  const visibleTerritories = Object.values(project.territories)
    .filter(
      (t) =>
        !t.hidden &&
        layerEffective(project, t.layerId).visible &&
        visibleInTime(t.timeline, project.timeline),
    )
    // Parents first so children draw on top of them.
    .sort((a, b) => depth(project, a.id) - depth(project, b.id));

  for (const t of visibleTerritories) {
    const style = resolveTerritoryStyle(project, t);
    const d = polygonToPath(t.geometry, p);
    if (!d) continue;
    const parts = [
      `<path d="${d}" fill="${toCss(style.fillColor, style.fillOpacity)}" fill-rule="evenodd"/>`,
    ];
    if (style.pattern && style.pattern.kind !== 'none') {
      const id = svgPatternId(style.pattern);
      if (!patterns.has(id)) patterns.set(id, style.pattern);
      parts.push(`<path d="${d}" fill="url(#${id})" fill-rule="evenodd"/>`);
    }
    if (style.outline.width > 0 && style.outline.opacity > 0) {
      parts.push(`<path d="${d}" ${strokeAttrs(style.outline, scale)}/>`);
    }
    territories.push(
      `<g id="territory-${esc(t.id)}" data-name="${esc(t.name)}" data-type="${esc(String(t.politicalType))}">${parts.join('')}</g>`,
    );
  }
  groups.push(group('territories', territories));
  // Inland water over the political fills, as on screen and as in print.
  if (waterOverlay.length) groups.push(group('water-bodies', waterOverlay));

  // --- borders, split into internal and international per §66 ---------------
  const internal: string[] = [];
  const international: string[] = [];
  const borders = computeBorders(project);
  for (const b of borders) {
    const styleId = borderStyleId(b.kind);
    const style = project.styles.line[styleId]?.style;
    if (!style || style.width <= 0) continue;
    const d = lineToPath(b.geometry, p);
    if (!d) continue;

    let markup: string;
    if (isDoubleLine(style)) {
      const { outer, inner } = doubleLineWidths(style);
      markup =
        `<path d="${d}" stroke="${toCss(style.color, style.opacity)}" stroke-width="${num(outer * scale)}" fill="none"/>` +
        `<path d="${d}" stroke="${project.landColor}" stroke-width="${num(Math.max(0.2, inner) * scale)}" fill="none"/>`;
    } else {
      markup = `<path d="${d}" ${strokeAttrs(style, scale)}/>`;
    }
    (isSovereign(b.kind) ? international : internal).push(markup);
  }
  groups.push(group('internal-borders', internal));
  groups.push(group('international-borders', international));

  // --- rivers and roads -----------------------------------------------------
  const rivers: string[] = [...basemapRivers];
  const roads: string[] = [];
  for (const f of Object.values(project.linearFeatures)) {
    if (f.hidden || f.kind === 'label-path') continue;
    if (!layerEffective(project, f.layerId).visible) continue;
    if (!visibleInTime(f.timeline, project.timeline)) continue;
    const style = resolveLinearStyle(project, f);
    const d = lineToPath(f.geometry, p);
    if (!d) continue;
    const markup = `<path id="lf-${esc(f.id)}" d="${d}" ${strokeAttrs(style, scale)}/>`;
    if (f.kind.startsWith('river') || f.kind === 'canal') rivers.push(markup);
    else roads.push(markup);
  }
  groups.push(group('rivers', rivers));
  groups.push(group('roads', roads));

  // --- settlements ----------------------------------------------------------
  const settlements: string[] = [];
  for (const s of Object.values(project.settlements)) {
    if (s.hidden || !layerEffective(project, s.layerId).visible) continue;
    if (!visibleInTime(s.timeline, project.timeline)) continue;
    const pt = p(s.geometry.coordinates[0], s.geometry.coordinates[1]);
    if (!pt) continue;
    const style = resolveSymbolStyle(project, s);
    settlements.push(
      `<g id="settlement-${esc(s.id)}" data-name="${esc(s.name)}">${symbolToSvg(style, pt[0], pt[1], scale)}</g>`,
    );
  }
  // Reference cities sit under the document's own settlements, exactly as they
  // do on screen — your places win where they coincide.
  groups.push(group('settlements', [...basemapPlaces, ...settlements]));

  // --- labels: text stays text ---------------------------------------------
  const labels: string[] = [];
  const labelPathDefs: string[] = [];
  for (const l of Object.values(project.labels)) {
    if (l.hidden || !l.text.trim() || !layerEffective(project, l.layerId).visible) continue;
    if (!visibleInTime(l.timeline, project.timeline)) continue;
    const style = resolveTextStyle(project, l);
    const content = applyTextTransform(l.text, style.transform);

    // Text on a path (§12) uses SVG's own textPath, so it stays editable.
    if (l.pathId && project.linearFeatures[l.pathId]) {
      const path = project.linearFeatures[l.pathId];
      const d = lineToPath(path.geometry, p);
      if (d) {
        const pid = `labelpath-${esc(l.id)}`;
        labelPathDefs.push(`<path id="${pid}" d="${d}" fill="none"/>`);
        labels.push(
          `<text ${textAttrs(style, scale)}><textPath href="#${pid}" startOffset="50%" text-anchor="middle">${esc(content)}</textPath></text>`,
        );
        continue;
      }
    }

    const pt = p(l.anchor.coordinates[0], l.anchor.coordinates[1]);
    if (!pt) continue;
    const x = pt[0] + l.offset[0] * scale;
    const y = pt[1] + l.offset[1] * scale;
    const lines = content.split(/\r?\n/);
    const lineHeight = style.fontSize * style.lineHeight * scale;
    const startY = y - (lineHeight * (lines.length - 1)) / 2;
    const transform = l.rotation ? ` transform="rotate(${num(l.rotation)} ${num(x)} ${num(y)})"` : '';

    // letter-spacing adds a trailing gap after the final glyph in most renderers;
    // shifting a centred run by half a tracking unit re-centres it.
    const centringShift = style.align === 'center' ? -(style.tracking * scale) / 2 : 0;

    const tspans = lines
      .map(
        (line, i) =>
          `<tspan x="${num(x + centringShift)}" y="${num(startY + lineHeight * i)}" dominant-baseline="central">${esc(line)}</tspan>`,
      )
      .join('');
    labels.push(
      `<text id="label-${esc(l.id)}" ${textAttrs(style, scale)}${transform}>${tspans}</text>`,
    );
  }
  if (labelPathDefs.length) defs.push(...labelPathDefs);
  groups.push(group('labels', labels));

  // --- graticule ------------------------------------------------------------
  const graticule: string[] = [];
  if (opts.includeGraticule) {
    graticule.push(...buildGraticule(opts, p, frame, scale));
  }
  groups.push(group('graticule', graticule));

  // --- legend placeholder group, kept so the §66 structure is complete ------
  groups.push(group('legend', []));

  // --- frame ----------------------------------------------------------------
  const frameParts: string[] = [];
  if (opts.includeFrame) frameParts.push(...buildFrame(opts, frame, scale));
  if (opts.includeTitle) frameParts.push(...buildTitle(project, frame, scale));
  if (opts.includeScaleBar) frameParts.push(...buildScaleBar(opts, p, frame, scale));
  groups.push(group('frame', frameParts));

  // --- assemble -------------------------------------------------------------
  for (const [, pattern] of patterns) defs.push(svgPatternDef(pattern));

  const header =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${opts.width}" height="${opts.height}" viewBox="0 0 ${opts.width} ${opts.height}">\n` +
    `<title>${esc(project.meta.title || 'Map')}</title>\n` +
    `<desc>Made with After the Fall. Projection: ${esc(project.projection.name)}. ` +
    `Extent (WGS84): ${opts.extent.map((v) => v.toFixed(4)).join(', ')}</desc>\n`;

  const defsBlock = defs.length ? `<defs>\n${defs.join('\n')}\n</defs>\n` : '';
  const clip = `<rect width="${opts.width}" height="${opts.height}" fill="${opts.background ? project.oceanColor : 'none'}"/>\n`;

  return `${header}${defsBlock}${opts.background ? clip : ''}${groups.join('\n')}\n</svg>\n`;
}

function group(id: string, children: string[]): string {
  return `<g id="${id}">${children.length ? `\n  ${children.join('\n  ')}\n` : ''}</g>`;
}

function depth(project: MapProject, id: UUID): number {
  let n = 0;
  let cur = project.territories[id]?.parentId ?? null;
  const seen = new Set<UUID>([id]);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    n++;
    cur = project.territories[cur]?.parentId ?? null;
  }
  return n;
}

function borderStyleId(kind: string): string {
  switch (kind) {
    case 'international': return STYLE_IDS.lineInternational;
    case 'major-political': return STYLE_IDS.lineMajor;
    case 'subordinate': return STYLE_IDS.lineSubordinate;
    case 'provincial': return STYLE_IDS.lineProvincial;
    case 'county': return STYLE_IDS.lineCounty;
    case 'disputed': return STYLE_IDS.lineDisputed;
    case 'ceasefire': return STYLE_IDS.lineCeasefire;
    case 'historical': return STYLE_IDS.lineHistorical;
    default: return STYLE_IDS.lineProvincial;
  }
}

function isSovereign(kind: string): boolean {
  return kind === 'international' || kind === 'major-political' || kind === 'disputed' || kind === 'ceasefire';
}

// ---------------------------------------------------------------------------
// Graticule, frame, title, scale bar (spec §23, §24, §25, §27)
// ---------------------------------------------------------------------------

function buildGraticule(
  opts: SvgExportOptions,
  p: Projector,
  frame: Frame,
  scale: number,
): string[] {
  const step = Math.max(0.5, opts.graticuleInterval);
  const [w, s, e, n] = opts.extent;
  const out: string[] = [];
  const stroke = `stroke="rgba(70,60,45,0.35)" stroke-width="${num(0.6 * scale)}" fill="none" stroke-dasharray="${num(1 * scale)} ${num(3 * scale)}"`;
  // Labels sit just *inside* the frame with a halo, so they are never clipped by
  // the margin and stay readable over land as well as water.
  const labelStyle =
    `font-family="Georgia,serif" font-size="${num(9 * scale)}" fill="#4a4034" ` +
    `paint-order="stroke" stroke="#fdfaf2" stroke-width="${num(2.4 * scale)}" stroke-linejoin="round"`;
  const inset = 7 * scale;

  const startLon = Math.ceil(w / step) * step;
  for (let lon = startLon; lon <= e; lon += step) {
    let d = '';
    let started = false;
    for (let lat = s; lat <= n + 1e-9; lat += (n - s) / 64) {
      const pt = p(lon, Math.min(lat, n));
      if (!pt) continue;
      d += `${started ? 'L' : 'M'}${num(pt[0])} ${num(pt[1])}`;
      started = true;
    }
    if (d) {
      out.push(`<path d="${d}" ${stroke}/>`);
      const top = p(lon, n);
      if (top && top[0] > frame.x + inset && top[0] < frame.x + frame.w - inset) {
        out.push(
          `<text x="${num(top[0])}" y="${num(frame.y + inset + 4 * scale)}" text-anchor="middle" ${labelStyle}>${formatDegrees(lon, 'lon')}</text>`,
        );
      }
    }
  }

  const startLat = Math.ceil(s / step) * step;
  for (let lat = startLat; lat <= n; lat += step) {
    let d = '';
    let started = false;
    for (let lon = w; lon <= e + 1e-9; lon += (e - w) / 64) {
      const pt = p(Math.min(lon, e), lat);
      if (!pt) continue;
      d += `${started ? 'L' : 'M'}${num(pt[0])} ${num(pt[1])}`;
      started = true;
    }
    if (d) {
      out.push(`<path d="${d}" ${stroke}/>`);
      const left = p(w, lat);
      if (left && left[1] > frame.y + inset * 2 && left[1] < frame.y + frame.h - inset) {
        out.push(
          `<text x="${num(frame.x + inset)}" y="${num(left[1])}" text-anchor="start" dominant-baseline="central" ${labelStyle}>${formatDegrees(lat, 'lat')}</text>`,
        );
      }
    }
  }
  return out;
}

export function formatDegrees(value: number, axis: 'lon' | 'lat'): string {
  const hemi = axis === 'lon' ? (value < 0 ? 'W' : 'E') : value < 0 ? 'S' : 'N';
  const abs = Math.abs(value);
  const whole = Math.round(abs * 100) / 100;
  return `${whole % 1 === 0 ? whole.toFixed(0) : whole.toFixed(2)}°${abs === 0 ? '' : hemi}`;
}

function buildFrame(opts: SvgExportOptions, frame: Frame, scale: number): string[] {
  const out: string[] = [];
  const ink = '#2b2318';

  if (opts.frameStyle === 'simple') {
    out.push(
      `<rect x="${num(frame.x)}" y="${num(frame.y)}" width="${num(frame.w)}" height="${num(frame.h)}" fill="none" stroke="${ink}" stroke-width="${num(1.5 * scale)}"/>`,
    );
    return out;
  }

  if (opts.frameStyle === 'double') {
    const gap = 4 * scale;
    out.push(
      `<rect x="${num(frame.x)}" y="${num(frame.y)}" width="${num(frame.w)}" height="${num(frame.h)}" fill="none" stroke="${ink}" stroke-width="${num(0.8 * scale)}"/>`,
      `<rect x="${num(frame.x - gap)}" y="${num(frame.y - gap)}" width="${num(frame.w + gap * 2)}" height="${num(frame.h + gap * 2)}" fill="none" stroke="${ink}" stroke-width="${num(2.2 * scale)}"/>`,
    );
    return out;
  }

  // Alternating coordinate blocks — the classic ruled atlas border.
  const band = 7 * scale;
  const blocks = 24;
  const bw = frame.w / blocks;
  const bh = frame.h / Math.max(1, Math.round(blocks * (frame.h / frame.w)));
  const rows = Math.max(1, Math.round(frame.h / bh));

  for (let i = 0; i < blocks; i++) {
    const fill = i % 2 === 0 ? ink : '#ffffff';
    out.push(
      `<rect x="${num(frame.x + i * bw)}" y="${num(frame.y - band)}" width="${num(bw)}" height="${num(band)}" fill="${fill}" stroke="${ink}" stroke-width="${num(0.5 * scale)}"/>`,
      `<rect x="${num(frame.x + i * bw)}" y="${num(frame.y + frame.h)}" width="${num(bw)}" height="${num(band)}" fill="${fill}" stroke="${ink}" stroke-width="${num(0.5 * scale)}"/>`,
    );
  }
  for (let i = 0; i < rows; i++) {
    const fill = i % 2 === 0 ? ink : '#ffffff';
    const h = frame.h / rows;
    out.push(
      `<rect x="${num(frame.x - band)}" y="${num(frame.y + i * h)}" width="${num(band)}" height="${num(h)}" fill="${fill}" stroke="${ink}" stroke-width="${num(0.5 * scale)}"/>`,
      `<rect x="${num(frame.x + frame.w)}" y="${num(frame.y + i * h)}" width="${num(band)}" height="${num(h)}" fill="${fill}" stroke="${ink}" stroke-width="${num(0.5 * scale)}"/>`,
    );
  }
  out.push(
    `<rect x="${num(frame.x)}" y="${num(frame.y)}" width="${num(frame.w)}" height="${num(frame.h)}" fill="none" stroke="${ink}" stroke-width="${num(1.2 * scale)}"/>`,
  );
  return out;
}

function buildTitle(project: MapProject, frame: Frame, scale: number): string[] {
  const title = project.meta.title?.trim();
  if (!title) return [];
  const subtitle = [project.meta.subtitle, project.meta.dateLine].filter(Boolean).join(' · ');
  const padX = 16 * scale;
  const padY = 12 * scale;
  const titleSize = 20 * scale;
  const subSize = 11 * scale;
  const boxW = Math.max(title.length * titleSize * 0.62, subtitle.length * subSize * 0.6) + padX * 2;
  const boxH = padY * 2 + titleSize + (subtitle ? subSize * 1.9 : 0);
  const x = frame.x + 18 * scale;
  const y = frame.y + 18 * scale;

  const parts = [
    `<rect x="${num(x)}" y="${num(y)}" width="${num(boxW)}" height="${num(boxH)}" fill="rgba(253,250,242,0.92)" stroke="#2b2318" stroke-width="${num(1.2 * scale)}"/>`,
    `<text x="${num(x + boxW / 2)}" y="${num(y + padY + titleSize * 0.78)}" text-anchor="middle" font-family="Georgia,serif" font-size="${num(titleSize)}" letter-spacing="${num(2 * scale)}" fill="#241d13">${esc(title.toUpperCase())}</text>`,
  ];
  if (subtitle) {
    parts.push(
      `<line x1="${num(x + padX)}" y1="${num(y + padY + titleSize * 1.15)}" x2="${num(x + boxW - padX)}" y2="${num(y + padY + titleSize * 1.15)}" stroke="#2b2318" stroke-width="${num(0.6 * scale)}"/>`,
      `<text x="${num(x + boxW / 2)}" y="${num(y + padY + titleSize * 1.15 + subSize * 1.5)}" text-anchor="middle" font-family="Georgia,serif" font-size="${num(subSize)}" font-style="italic" fill="#4a3d2b">${esc(subtitle)}</text>`,
    );
  }
  return parts;
}

function buildScaleBar(opts: SvgExportOptions, p: Projector, frame: Frame, scale: number): string[] {
  // Measure how many output px one degree of longitude spans at the map's
  // mid-latitude, then convert to km.
  const midLat = (opts.extent[1] + opts.extent[3]) / 2;
  const a = p(opts.extent[0], midLat);
  const b = p(opts.extent[2], midLat);
  if (!a || !b) return [];
  const pxSpan = Math.abs(b[0] - a[0]);
  const kmSpan = (opts.extent[2] - opts.extent[0]) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  if (pxSpan <= 0 || kmSpan <= 0) return [];
  const pxPerKm = pxSpan / kmSpan;

  // Pick a round distance that fills roughly a fifth of the map width.
  const targetPx = frame.w * 0.2;
  const roughKm = targetPx / pxPerKm;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughKm)));
  const niceKm = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).reduce((best, v) =>
    Math.abs(v * pxPerKm - targetPx) < Math.abs(best * pxPerKm - targetPx) ? v : best,
  );
  const barPx = niceKm * pxPerKm;

  const x = frame.x + frame.w - barPx - 24 * scale;
  const y = frame.y + frame.h - 26 * scale;
  const h = 6 * scale;
  const segments = 4;
  const out: string[] = [];
  for (let i = 0; i < segments; i++) {
    out.push(
      `<rect x="${num(x + (barPx / segments) * i)}" y="${num(y)}" width="${num(barPx / segments)}" height="${num(h)}" ` +
        `fill="${i % 2 === 0 ? '#2b2318' : '#fdfaf2'}" stroke="#2b2318" stroke-width="${num(0.7 * scale)}"/>`,
    );
  }
  out.push(
    `<text x="${num(x)}" y="${num(y - 4 * scale)}" font-family="Georgia,serif" font-size="${num(9 * scale)}" fill="#2b2318">0</text>`,
    `<text x="${num(x + barPx)}" y="${num(y - 4 * scale)}" text-anchor="end" font-family="Georgia,serif" font-size="${num(9 * scale)}" fill="#2b2318">${niceKm >= 1 ? niceKm.toLocaleString() : niceKm} km</text>`,
  );
  return out;
}

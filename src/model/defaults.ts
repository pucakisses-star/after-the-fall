/**
 * Built-in style classes, palettes and border hierarchy (spec §8, §9, §21, §40).
 *
 * These ids are fixed strings so a project saved today still resolves its styles
 * after an upgrade. Built-in classes can be edited but not deleted.
 */

import { fixedId } from './ids';
import type {
  BorderStyleKind,
  LineStyle,
  PoliticalType,
  SettlementType,
  StyleSheet,
  SymbolStyle,
  TerritoryStyle,
  TextStyle,
  UUID,
} from './types';

export const STYLE_IDS = {
  territoryDefault: fixedId('terr-default'),
  territoryWater: fixedId('terr-water'),
  territoryDisputed: fixedId('terr-disputed'),
  territoryOccupied: fixedId('terr-occupied'),

  lineInternational: fixedId('line-international'),
  lineMajor: fixedId('line-major'),
  lineSubordinate: fixedId('line-subordinate'),
  lineProvincial: fixedId('line-provincial'),
  lineCounty: fixedId('line-county'),
  lineDisputed: fixedId('line-disputed'),
  lineCeasefire: fixedId('line-ceasefire'),
  lineHistorical: fixedId('line-historical'),
  lineRiver: fixedId('line-river'),
  lineRiverMajor: fixedId('line-river-major'),
  lineRoadMajor: fixedId('line-road-major'),
  lineRoadMinor: fixedId('line-road-minor'),
  lineTradeRoute: fixedId('line-trade-route'),

  textCountry: fixedId('text-country'),
  textRegion: fixedId('text-region'),
  textCity: fixedId('text-city'),
  textCapital: fixedId('text-capital'),
  textOcean: fixedId('text-ocean'),
  textWater: fixedId('text-water'),
  textRiver: fixedId('text-river'),

  symbolCapitalImperial: fixedId('sym-cap-imperial'),
  symbolCapitalNational: fixedId('sym-cap-national'),
  symbolCapitalRegional: fixedId('sym-cap-regional'),
  symbolCity: fixedId('sym-city'),
  symbolTown: fixedId('sym-town'),
  symbolVillage: fixedId('sym-village'),
  symbolFortress: fixedId('sym-fortress'),
  symbolPort: fixedId('sym-port'),
  symbolMonastery: fixedId('sym-monastery'),
  symbolRuins: fixedId('sym-ruins'),
} as const;

const SERIF = "'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif";
const SANS = "'Inter','Helvetica Neue',Helvetica,Arial,sans-serif";

export function defaultLineStyle(over: Partial<LineStyle> = {}): LineStyle {
  return {
    color: '#3a3128',
    width: 1,
    opacity: 1,
    dash: 'solid',
    casingColor: null,
    casingWidth: 0,
    lineCap: 'round',
    lineJoin: 'round',
    ...over,
  };
}

export function defaultTextStyle(over: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: SERIF,
    fontSize: 13,
    fontWeight: 400,
    italic: false,
    color: '#2b2318',
    opacity: 1,
    tracking: 0,
    lineHeight: 1.15,
    transform: 'none',
    haloColor: '#fdfaf2',
    haloWidth: 2.5,
    outlineColor: null,
    outlineWidth: 0,
    align: 'center',
    ...over,
  };
}

export function defaultSymbolStyle(over: Partial<SymbolStyle> = {}): SymbolStyle {
  return {
    shape: 'circle',
    size: 7,
    fillColor: '#fdfaf2',
    strokeColor: '#2b2318',
    strokeWidth: 1.1,
    opacity: 1,
    customPath: null,
    ...over,
  };
}

export function defaultTerritoryStyle(over: Partial<TerritoryStyle> = {}): TerritoryStyle {
  return {
    fillColor: '#d8c9a8',
    fillOpacity: 0.85,
    pattern: null,
    outline: defaultLineStyle({ width: 0.6, color: '#6b5f4d', opacity: 0.7 }),
    ...over,
  };
}

/**
 * Border hierarchy (spec §8). The visual gradient here is the whole point of the
 * reference style: sovereign borders read as heavy dark lines, county borders as
 * whisper-thin grey hairlines.
 */
export const BORDER_HIERARCHY: {
  kind: BorderStyleKind;
  label: string;
  styleClassId: UUID;
  /** Higher wins where two territories of different rank share an edge. */
  weight: number;
}[] = [
  { kind: 'international', label: 'International border', styleClassId: STYLE_IDS.lineInternational, weight: 100 },
  { kind: 'major-political', label: 'Major political border', styleClassId: STYLE_IDS.lineMajor, weight: 80 },
  { kind: 'subordinate', label: 'Subordinate-state border', styleClassId: STYLE_IDS.lineSubordinate, weight: 60 },
  { kind: 'provincial', label: 'Provincial border', styleClassId: STYLE_IDS.lineProvincial, weight: 40 },
  { kind: 'county', label: 'County border', styleClassId: STYLE_IDS.lineCounty, weight: 20 },
  { kind: 'disputed', label: 'Disputed border', styleClassId: STYLE_IDS.lineDisputed, weight: 90 },
  { kind: 'ceasefire', label: 'Ceasefire line', styleClassId: STYLE_IDS.lineCeasefire, weight: 85 },
  { kind: 'historical', label: 'Historical boundary', styleClassId: STYLE_IDS.lineHistorical, weight: 30 },
];

export function borderStyleClassFor(kind: BorderStyleKind): UUID {
  return BORDER_HIERARCHY.find((b) => b.kind === kind)?.styleClassId ?? STYLE_IDS.lineProvincial;
}

export function borderWeightFor(kind: BorderStyleKind): number {
  return BORDER_HIERARCHY.find((b) => b.kind === kind)?.weight ?? 10;
}

/** Which border weight a territory gets by default, from its political rank. */
export const POLITICAL_TYPES: { value: PoliticalType; label: string; rank: number; border: BorderStyleKind }[] = [
  { value: 'empire', label: 'Empire', rank: 0, border: 'international' },
  { value: 'kingdom', label: 'Kingdom', rank: 1, border: 'international' },
  { value: 'grand-duchy', label: 'Grand Duchy', rank: 2, border: 'major-political' },
  { value: 'duchy', label: 'Duchy', rank: 3, border: 'subordinate' },
  { value: 'principality', label: 'Principality', rank: 3, border: 'subordinate' },
  { value: 'county', label: 'County', rank: 4, border: 'county' },
  { value: 'barony', label: 'Barony', rank: 5, border: 'county' },
  { value: 'republic', label: 'Republic', rank: 1, border: 'international' },
  { value: 'city-state', label: 'City-State', rank: 2, border: 'international' },
  { value: 'confederation', label: 'Confederation', rank: 0, border: 'international' },
  { value: 'tribal-confederacy', label: 'Tribal Confederacy', rank: 1, border: 'major-political' },
  { value: 'bishopric', label: 'Bishopric', rank: 3, border: 'subordinate' },
  { value: 'theocracy', label: 'Theocracy', rank: 1, border: 'international' },
  { value: 'march', label: 'March', rank: 3, border: 'subordinate' },
  { value: 'protectorate', label: 'Protectorate', rank: 2, border: 'major-political' },
  { value: 'colony', label: 'Colony', rank: 2, border: 'major-political' },
  { value: 'vassal', label: 'Vassal', rank: 3, border: 'subordinate' },
  { value: 'autonomous-territory', label: 'Autonomous Territory', rank: 3, border: 'subordinate' },
  { value: 'occupied-territory', label: 'Occupied Territory', rank: 2, border: 'ceasefire' },
  { value: 'disputed-territory', label: 'Disputed Territory', rank: 2, border: 'disputed' },
  { value: 'province', label: 'Province', rank: 4, border: 'provincial' },
  { value: 'district', label: 'District', rank: 5, border: 'county' },
];

export function politicalTypeInfo(t: PoliticalType) {
  return POLITICAL_TYPES.find((p) => p.value === t);
}

export const SETTLEMENT_TYPES: {
  value: SettlementType;
  label: string;
  styleClassId: UUID;
  textStyleId: UUID;
}[] = [
  { value: 'imperial-capital', label: 'Imperial Capital', styleClassId: STYLE_IDS.symbolCapitalImperial, textStyleId: STYLE_IDS.textCapital },
  { value: 'national-capital', label: 'National Capital', styleClassId: STYLE_IDS.symbolCapitalNational, textStyleId: STYLE_IDS.textCapital },
  { value: 'regional-capital', label: 'Regional Capital', styleClassId: STYLE_IDS.symbolCapitalRegional, textStyleId: STYLE_IDS.textCity },
  { value: 'city', label: 'City', styleClassId: STYLE_IDS.symbolCity, textStyleId: STYLE_IDS.textCity },
  { value: 'town', label: 'Town', styleClassId: STYLE_IDS.symbolTown, textStyleId: STYLE_IDS.textCity },
  { value: 'village', label: 'Village', styleClassId: STYLE_IDS.symbolVillage, textStyleId: STYLE_IDS.textCity },
  { value: 'fortress', label: 'Fortress', styleClassId: STYLE_IDS.symbolFortress, textStyleId: STYLE_IDS.textCity },
  { value: 'port', label: 'Port', styleClassId: STYLE_IDS.symbolPort, textStyleId: STYLE_IDS.textCity },
  { value: 'monastery', label: 'Monastery', styleClassId: STYLE_IDS.symbolMonastery, textStyleId: STYLE_IDS.textCity },
  { value: 'ruins', label: 'Ruins', styleClassId: STYLE_IDS.symbolRuins, textStyleId: STYLE_IDS.textCity },
];

export function settlementTypeInfo(t: SettlementType) {
  return SETTLEMENT_TYPES.find((s) => s.value === t) ?? SETTLEMENT_TYPES[3];
}

// ---------------------------------------------------------------------------
// Palettes (spec §22)
// ---------------------------------------------------------------------------

export type PaletteMode = 'pastel' | 'muted' | 'vibrant' | 'historical-atlas' | 'monochromatic' | 'random';

export const PALETTES: Record<Exclude<PaletteMode, 'random' | 'monochromatic'>, string[]> = {
  pastel: [
    '#e8c9c2', '#cfdcc4', '#c6d4e4', '#e6dcbe', '#d8c8dd', '#c4dcd8',
    '#eed6bd', '#d3d8e8', '#dfe3c6', '#e4c7d4', '#c9dee6', '#e9dfcb',
  ],
  muted: [
    '#c4a68f', '#9fae8c', '#8fa3b5', '#c2b382', '#a894ab', '#8fb0a8',
    '#c9a887', '#a2a9c0', '#b3b992', '#bf94a2', '#93b3bd', '#c5b79a',
  ],
  vibrant: [
    '#d9694e', '#5f9e56', '#4b7fbd', '#d9ab3e', '#8a5fa8', '#3fa393',
    '#d97f36', '#6a6fc0', '#93b83b', '#c44d84', '#41a5c4', '#b58b3d',
  ],
  // Sampled from the flat lithographic inks of 19th/20th-century school atlases.
  'historical-atlas': [
    '#dcc9a4', '#b9c4a2', '#c9b7c2', '#a8bcc4', '#ddb99a', '#c2c8b0',
    '#cbb894', '#adbdb2', '#d4bdb0', '#b6b7c9', '#d9cdb0', '#bfae9c',
  ],
};

// ---------------------------------------------------------------------------
// Built-in stylesheet
// ---------------------------------------------------------------------------

export function createDefaultStyleSheet(): StyleSheet {
  const sheet: StyleSheet = { territory: {}, line: {}, text: {}, symbol: {} };

  const terr = (id: UUID, name: string, style: TerritoryStyle) => {
    sheet.territory[id] = { id, name, builtin: true, style };
  };
  const line = (id: UUID, name: string, style: LineStyle) => {
    sheet.line[id] = { id, name, builtin: true, style };
  };
  const text = (id: UUID, name: string, style: TextStyle) => {
    sheet.text[id] = { id, name, builtin: true, style };
  };
  const sym = (id: UUID, name: string, style: SymbolStyle) => {
    sheet.symbol[id] = { id, name, builtin: true, style };
  };

  terr(STYLE_IDS.territoryDefault, 'Territory', defaultTerritoryStyle());
  terr(
    STYLE_IDS.territoryWater,
    'Water body',
    defaultTerritoryStyle({
      fillColor: '#c3d8e4',
      fillOpacity: 1,
      outline: defaultLineStyle({ color: '#7d9bad', width: 0.7 }),
    }),
  );
  terr(
    STYLE_IDS.territoryDisputed,
    'Disputed territory',
    defaultTerritoryStyle({
      fillColor: '#d8c9a8',
      fillOpacity: 0.55,
      pattern: { kind: 'diagonal', angle: 0, spacing: 7, thickness: 1, color: '#8a3b2e', opacity: 0.75 },
      outline: defaultLineStyle({ color: '#8a3b2e', width: 1.1, dash: 'dashed' }),
    }),
  );
  terr(
    STYLE_IDS.territoryOccupied,
    'Military occupation',
    defaultTerritoryStyle({
      fillColor: '#cfc4b4',
      fillOpacity: 0.6,
      pattern: { kind: 'crosshatch', angle: 0, spacing: 9, thickness: 0.8, color: '#4a4038', opacity: 0.6 },
      outline: defaultLineStyle({ color: '#4a4038', width: 1, dash: 'dash-dot' }),
    }),
  );

  line(STYLE_IDS.lineInternational, 'International border', defaultLineStyle({ color: '#2f2417', width: 2.2 }));
  line(STYLE_IDS.lineMajor, 'Major political border', defaultLineStyle({ color: '#463825', width: 1.5 }));
  line(STYLE_IDS.lineSubordinate, 'Subordinate-state border', defaultLineStyle({ color: '#5c4c35', width: 1.0 }));
  line(STYLE_IDS.lineProvincial, 'Provincial border', defaultLineStyle({ color: '#7a6b56', width: 0.6, opacity: 0.85 }));
  line(STYLE_IDS.lineCounty, 'County border', defaultLineStyle({ color: '#8f8371', width: 0.35, opacity: 0.7 }));
  line(STYLE_IDS.lineDisputed, 'Disputed border', defaultLineStyle({ color: '#8a3b2e', width: 1.6, dash: 'dashed' }));
  line(STYLE_IDS.lineCeasefire, 'Ceasefire line', defaultLineStyle({ color: '#3f5a7a', width: 1.5, dash: 'dash-dot' }));
  line(STYLE_IDS.lineHistorical, 'Historical boundary', defaultLineStyle({ color: '#6b5f4d', width: 0.9, dash: 'dotted' }));
  line(STYLE_IDS.lineRiver, 'River', defaultLineStyle({ color: '#7f9fb5', width: 1 }));
  line(STYLE_IDS.lineRiverMajor, 'Major river', defaultLineStyle({ color: '#6c93ad', width: 1.9 }));
  line(STYLE_IDS.lineRoadMajor, 'Major road', defaultLineStyle({ color: '#9c6b45', width: 1.4 }));
  line(STYLE_IDS.lineRoadMinor, 'Minor road', defaultLineStyle({ color: '#a98a66', width: 0.8, dash: 'dashed' }));
  line(STYLE_IDS.lineTradeRoute, 'Trade route', defaultLineStyle({ color: '#8a7350', width: 1.1, dash: 'dash-dot' }));

  text(
    STYLE_IDS.textCountry,
    'Country label',
    defaultTextStyle({ fontSize: 17, tracking: 6, transform: 'uppercase', color: '#241d13', haloWidth: 3 }),
  );
  text(STYLE_IDS.textRegion, 'Region label', defaultTextStyle({ fontSize: 12, tracking: 1.6, italic: true, color: '#4a3d2b' }));
  text(STYLE_IDS.textCity, 'City label', defaultTextStyle({ fontSize: 11, tracking: 0.2, align: 'left' }));
  text(
    STYLE_IDS.textCapital,
    'Capital label',
    defaultTextStyle({ fontSize: 12, fontWeight: 600, tracking: 0.4, align: 'left' }),
  );
  text(
    STYLE_IDS.textOcean,
    'Ocean label',
    defaultTextStyle({
      fontSize: 18,
      tracking: 14,
      italic: true,
      transform: 'uppercase',
      color: '#4c6f86',
      haloColor: '#e8f1f6',
      haloWidth: 3,
      fontFamily: SERIF,
    }),
  );
  text(
    STYLE_IDS.textWater,
    'Water label',
    defaultTextStyle({ fontSize: 12, tracking: 3, italic: true, color: '#5d8197', haloColor: '#e8f1f6' }),
  );
  text(
    STYLE_IDS.textRiver,
    'River label',
    defaultTextStyle({ fontSize: 10, tracking: 1.2, italic: true, color: '#5d8197', haloColor: '#f2f7fa' }),
  );

  sym(STYLE_IDS.symbolCapitalImperial, 'Imperial capital', defaultSymbolStyle({ shape: 'star', size: 13 }));
  sym(STYLE_IDS.symbolCapitalNational, 'National capital', defaultSymbolStyle({ shape: 'double-circle', size: 10 }));
  sym(STYLE_IDS.symbolCapitalRegional, 'Regional capital', defaultSymbolStyle({ shape: 'filled-circle', size: 7.5 }));
  sym(STYLE_IDS.symbolCity, 'City', defaultSymbolStyle({ shape: 'circle', size: 6.5 }));
  sym(STYLE_IDS.symbolTown, 'Town', defaultSymbolStyle({ shape: 'circle', size: 5 }));
  sym(STYLE_IDS.symbolVillage, 'Village', defaultSymbolStyle({ shape: 'filled-circle', size: 3.2 }));
  sym(STYLE_IDS.symbolFortress, 'Fortress', defaultSymbolStyle({ shape: 'castle', size: 9 }));
  sym(STYLE_IDS.symbolPort, 'Port', defaultSymbolStyle({ shape: 'anchor', size: 9 }));
  sym(STYLE_IDS.symbolMonastery, 'Monastery', defaultSymbolStyle({ shape: 'cross', size: 8 }));
  sym(STYLE_IDS.symbolRuins, 'Ruins', defaultSymbolStyle({ shape: 'ruins', size: 8.5, fillColor: '#00000000' }));

  return sheet;
}

export const FONT_STACKS: { label: string; value: string }[] = [
  { label: 'Serif (Palatino / Iowan)', value: SERIF },
  { label: 'Sans (Inter / Helvetica)', value: SANS },
  { label: 'Garamond', value: "'EB Garamond',Garamond,'Times New Roman',serif" },
  { label: 'Times', value: "'Times New Roman',Times,serif" },
  { label: 'Baskerville', value: "Baskerville,'Libre Baskerville',Georgia,serif" },
  { label: 'Didot', value: "Didot,'Bodoni MT','Playfair Display',serif" },
  { label: 'Optima', value: "Optima,'Gill Sans','Gill Sans MT',sans-serif" },
  { label: 'Copperplate', value: "Copperplate,'Copperplate Gothic Light',fantasy" },
  { label: 'Monospace', value: "'SF Mono',Menlo,Consolas,monospace" },
];

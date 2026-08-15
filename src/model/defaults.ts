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
  PoliticalCohesion,
  PoliticalRelationship,
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
  textRelationship: fixedId('text-relationship'),

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

/**
 * What each constitutional status means to the renderer (spec §2, §6, §7, §17,
 * §26, §35).
 *
 * This table is the whole point of separating status from rank: given only
 * "Dubuque is a county, is a vassal, belongs to the Midwest Confederation", the
 * renderer reads its fill, its border, its label class and its subtitle from
 * here. Nothing about a vassal's appearance is set by hand on the vassal.
 *
 *   variation  how far the fill may drift from the parent's, 0–1, before the
 *              project's cohesion setting scales it. Ordinary members barely
 *              move; a vassal moves enough to be obviously a different kind of
 *              thing while staying in the family.
 *   border     the line drawn round it *inside* its parent. Never
 *              `international` for anything held by somebody — that is what
 *              stops a vassal's edge reading like a national frontier.
 *   emphasis   which label class it takes: quiet italic for ordinary members,
 *              uppercase for a special status, full country treatment for a
 *              sovereign.
 *   subtitle   template for the line under the name, `{parent}` being the
 *              parent's short name. Null where a subtitle would be noise.
 */
export const POLITICAL_RELATIONSHIPS: {
  value: PoliticalRelationship;
  label: string;
  variation: number;
  border: BorderStyleKind;
  emphasis: 'sovereign' | 'constituent' | 'special';
  subtitle: string | null;
  /** Free cities pick their own colour rather than inheriting one. */
  ownColor?: boolean;
}[] = [
  { value: 'sovereign', label: 'Sovereign', variation: 0, border: 'international', emphasis: 'sovereign', subtitle: null },
  { value: 'constituent', label: 'Constituent state', variation: 0.08, border: 'provincial', emphasis: 'constituent', subtitle: null },
  { value: 'vassal', label: 'Vassal', variation: 0.3, border: 'subordinate', emphasis: 'special', subtitle: 'Vassal of the {parent}' },
  { value: 'autonomous-vassal', label: 'Autonomous vassal', variation: 0.2, border: 'subordinate', emphasis: 'special', subtitle: 'Autonomous vassal of the {parent}' },
  { value: 'tributary', label: 'Tributary', variation: 0.24, border: 'subordinate', emphasis: 'special', subtitle: 'Tributary of the {parent}' },
  { value: 'personal-union', label: 'Personal union', variation: 0.14, border: 'major-political', emphasis: 'special', subtitle: 'In personal union with the {parent}' },
  { value: 'free-city', label: 'Free city', variation: 0.5, border: 'major-political', emphasis: 'special', subtitle: 'Free City', ownColor: true },
  { value: 'march', label: 'March', variation: 0.2, border: 'subordinate', emphasis: 'special', subtitle: 'March of the {parent}' },
  { value: 'protectorate', label: 'Protectorate', variation: 0.26, border: 'major-political', emphasis: 'special', subtitle: 'Protectorate of the {parent}' },
  { value: 'occupied', label: 'Occupied', variation: 0.32, border: 'ceasefire', emphasis: 'special', subtitle: 'Occupied by the {parent}' },
  { value: 'disputed', label: 'Disputed', variation: 0.32, border: 'disputed', emphasis: 'special', subtitle: 'Disputed' },
];

export function relationshipInfo(r: PoliticalRelationship) {
  return POLITICAL_RELATIONSHIPS.find((x) => x.value === r) ?? POLITICAL_RELATIONSHIPS[1];
}

/** How strongly members are drawn as part of their realm (spec §18). */
export const POLITICAL_COHESION: { value: PoliticalCohesion; label: string; factor: number; hint: string }[] = [
  { value: 'unified', label: 'Unified', factor: 0.3, hint: 'Members are almost the same colour as the realm.' },
  { value: 'strong', label: 'Strong', factor: 0.65, hint: 'Small variations. Reads as one realm at a glance.' },
  { value: 'moderate', label: 'Moderate', factor: 1, hint: 'Clearly distinguishable related shades.' },
  { value: 'loose', label: 'Loose', factor: 1.7, hint: 'A broad family, still recognisably related.' },
  { value: 'independent', label: 'Independent', factor: 0, hint: 'No inheritance — every member keeps its own colour.' },
];

export function cohesionFactor(c: PoliticalCohesion | undefined): number {
  return POLITICAL_COHESION.find((x) => x.value === c)?.factor ?? 0.65;
}

/**
 * The status a territory should have when nothing has said otherwise.
 *
 * Documents written before status existed carry it inside `politicalType`, so
 * the six ranks that are really statuses are read back out; everything else is
 * sovereign if it stands alone and an ordinary member if it does not.
 */
export function inferRelationship(
  politicalType: PoliticalType,
  hasParent: boolean,
): PoliticalRelationship {
  switch (politicalType) {
    case 'vassal':
      return 'vassal';
    case 'autonomous-territory':
      return 'autonomous-vassal';
    case 'protectorate':
      return 'protectorate';
    case 'colony':
      return 'protectorate';
    case 'march':
      return 'march';
    case 'occupied-territory':
      return 'occupied';
    case 'disputed-territory':
      return 'disputed';
    case 'city-state':
      return hasParent ? 'free-city' : 'sovereign';
    default:
      return hasParent ? 'constituent' : 'sovereign';
  }
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

export type PaletteMode =
  | 'pastel'
  | 'muted'
  | 'vibrant'
  | 'historical-atlas'
  | 'after-the-event'
  | 'imperial-patchwork'
  | 'jewel'
  | 'sepia'
  | 'monochromatic'
  | 'random';

export const PALETTES: Record<Exclude<PaletteMode, 'random' | 'monochromatic'>, string[]> = {
  pastel: [
    '#e8c9c2', '#cfdcc4', '#c6d4e4', '#e6dcbe', '#d8c8dd', '#c4dcd8',
    '#eed6bd', '#d3d8e8', '#dfe3c6', '#e4c7d4', '#c9dee6', '#e9dfcb',
  ],
  muted: [
    '#c4a68f', '#9fae8c', '#8fa3b5', '#c2b382', '#a894ab', '#8fb0a8',
    '#d2a06e', '#a2a9c0', '#b3b992', '#bf94a2', '#93b3bd', '#c5b79a',
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
  /**
   * The fan-made After the End plates: saturated but earthed, never fluorescent.
   *
   * Twenty rather than twelve on purpose. The graph colourer only guarantees
   * that *neighbours* differ, so a short list satisfies it while still printing
   * the same eight colours across a continent — which is what makes a map of a
   * hundred and thirty states read as eight blocs. More hues cost nothing and
   * buy variety two realms apart, where the eye actually notices repetition.
   */
  'after-the-event': [
    '#4c9aa8', '#b8405f', '#4aac52', '#9aad3e', '#d98d3e', '#7093c6',
    '#8a5a3e', '#a5382f', '#9c88b8', '#8fa08c', '#3f6aab', '#d4a950',
    '#c98d9c', '#6f7a3e', '#d98d7c', '#b8a87a', '#57b6c6', '#a8546f',
    '#7fae66', '#c46a3a',
  ],
  /**
   * The Holy Roman Empire of America plate: a dense pastel patchwork where every
   * county carries its own tint and the empire is held together by its frame and
   * its borders rather than by colour.
   *
   * Twenty-four light tints with a few saturated accents, which is what stops a
   * wash of pastels going flat over a whole map.
   */
  'imperial-patchwork': [
    '#e9dfa8', '#bfe0c4', '#f0c8d4', '#cfc4e6', '#f2d3b0', '#bcd4ee',
    '#d8e4ae', '#eec9c2', '#c2e2e0', '#e4d0e8', '#f0e3c0', '#c8d8bc',
    '#e8bcc8', '#b8cde2', '#ded0a8', '#cbe6d2', '#e6c6e0', '#f6d7a4',
    '#aecfd8', '#ddc0a6', '#c4c8e8', '#e0e8bc', '#d24a4a', '#c8489a',
  ],
  /**
   * Deep inks for a map printed dark: a night plate, or a realm map meant to
   * look like enamel rather than paper.
   */
  jewel: [
    '#2f5d78', '#7a2f46', '#3d6b4a', '#6b5a2a', '#4a3a6b', '#2a6b6b',
    '#8a4a2a', '#3a4a7a', '#6b3a5a', '#4a6b2a', '#7a5a3a', '#2a5a4a',
    '#5a2a4a', '#3a6b7a', '#6b4a2a', '#4a2a5a',
  ],
  /** One ink, many washes — an engraved plate tinted by hand. */
  sepia: [
    '#d9c4a0', '#c4a882', '#e0d2b4', '#b09068', '#cdb694', '#a88458',
    '#e6dcc4', '#bfa176', '#d2bb96', '#9c7a4e', '#dccdb0', '#b59a72',
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
    defaultTextStyle({ fontSize: 17, tracking: 6, transform: 'uppercase', color: '#241d13', haloWidth: 1.2 }),
  );
  text(
    STYLE_IDS.textRegion,
    'Region label',
    // A halo, not a pill. Three pixels of white behind every name turned the map
    // into a field of UI chips; just over one keeps the name legible where it
    // crosses a border without printing a box around it.
    defaultTextStyle({ fontSize: 12, tracking: 1.6, italic: true, color: '#4a3d2b', haloWidth: 1.2 }),
  );
  // The line under a special vassal's name — "Vassal of the M.C." Smaller and
  // lighter than the name it belongs to, because it is an annotation on that
  // name rather than a second name (spec §12).
  text(
    STYLE_IDS.textRelationship,
    'Relationship note',
    defaultTextStyle({ fontSize: 8, tracking: 0.3, italic: true, color: '#5c5040', haloWidth: 2 }),
  );
  text(
    STYLE_IDS.textCity,
    'City label',
    defaultTextStyle({ fontSize: 11, tracking: 0.2, align: 'left', haloWidth: 1.5 }),
  );
  text(
    STYLE_IDS.textCapital,
    'Capital label',
    defaultTextStyle({ fontSize: 12, fontWeight: 600, tracking: 0.4, align: 'left', haloWidth: 1.5 }),
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

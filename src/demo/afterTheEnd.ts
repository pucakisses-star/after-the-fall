/**
 * A political map of the post-apocalyptic Americas, after the *After the End*
 * setting for Crusader Kings (spec §65 — a worked example, not a special case).
 *
 * Every realm here is built by the same public API the UI uses: shapes grown
 * from a seat of power by `geo/realmGrowth`, arranged into the empire → vassal
 * hierarchy of §7, given the border tiers of §8, and labelled by the same label
 * engine as anything you draw yourself. Nothing in the application knows this
 * file exists.
 *
 * On the shapes. They are deliberately not modern state, provincial or
 * departmental boundaries. A collapsed world that still divides at the state
 * line is not a collapsed world, and the maps this is modelled on — realms
 * spreading from a city until they meet a rival, with real wilderness between
 * them — cannot be drawn by dissolving units somebody else defined. So each
 * realm claims outward from its seat at a rate set by its strength, and the
 * frontier falls where two claims meet.
 *
 * On the names. Realm names, their tier and the empire each belongs to are
 * taken from the setting's own realm list. Where a realm sits is an informed
 * placement, not a tracing of the mod's province map, which is not published as
 * geodata. Read it as a plausible atlas of that world — and every border is an
 * ordinary editable territory, which is the point of the application.
 */

import { linesOf, loadBasemap, pointsOf, polygonsOf } from '@/geo/basemap';
import { memberCountFor, pickSeats, subdivideRealm, type SubdivisionSeat } from '@/geo/subdivide';
import { fitLabel } from '@/render/labelFit';
import { relationshipInfo } from '@/model/defaults';
import { areaKm2, bbox, interiorPoint, intersection } from '@/geo/operations';
import { landPolygonsOf } from '@/geo/coastline';
import { recolor } from '@/geo/palette';
import { DEFAULT_GROWTH, growRealms, type LandPolygon, type RealmSeed } from '@/geo/realmGrowth';
import { PALETTES, STYLE_IDS, defaultFixedSize } from '@/model/defaults';
import { createProject, findLayerByKind } from '@/model/project';
import { deserializeProject } from '@/persistence/projectFile';
import { newId } from '@/model/ids';
import type {
  MapLabel,
  MapProject,
  PoliticalRelationship,
  PoliticalType,
  Settlement,
  Territory,
  TextStyle,
} from '@/model/types';
import type { LineString, MultiLineString, MultiPolygon, Polygon, Position } from 'geojson';

/** A vassal realm: a name, a seat, and how far its writ runs. */
interface Realm {
  name: string;
  short: string;
  type: PoliticalType;
  /** Seat of power, and where its growth starts. */
  seat: [number, number];
  /** Relative reach. 1 is an ordinary kingdom; a city-state is well under it. */
  weight: number;
  /** Extra growth origins, for a realm that straddles water or a range. */
  also?: [number, number][];
  /** This realm's seat is the empire's capital. */
  capital?: boolean;
  /** WGS84 [w, s, e, n] this realm may not grow outside of. */
  bounds?: [number, number, number, number];
  /**
   * Never break this realm into members.
   *
   * The builder divides anything over twenty thousand square kilometres among
   * its towns, which is right for a realm invented from a seat and a weight and
   * wrong for one copied off a plate: the plate's own names are the answer, and
   * a county of the Salish Sea that grew inland until it qualified would come
   * back as four counties named after towns nobody drew.
   */
  whole?: boolean;
}

interface Empire {
  name: string;
  short: string;
  type: PoliticalType;
  color: string;
  /** Where to set the empire's name, when the centre of its area will not do. */
  label?: [number, number];
  realms: Realm[];
}

const A = PALETTES['historical-atlas'];
const M = PALETTES.muted;

/**
 * The ground each county of the Salish Sea plate is drawn on.
 *
 * Weight alone cannot hold a realm to the ground it was copied from. A county
 * with nothing seeded beyond it keeps going until the coverage budget stops it,
 * and measured on this map that meant the County of Clallam taking the west
 * coast of Vancouver Island — 120,000 km² — and Thompson reaching the middle of
 * British Columbia. A box per county says where each was drawn; the free cities
 * need none, because they are hemmed in by the counties on every side.
 *
 * One box for the whole plate would be simpler and looks it: the frontier then
 * runs dead straight across Vancouver Island and the Cascades, which is what an
 * administrative rectangle looks like when it is drawn over mountains. These
 * are cut to the ground instead — a peninsula, a canyon, a coastal strip.
 */
const SALISH_GROUND: Record<string, [number, number, number, number]> = {
  // The one free city with open ground at its back: bounded like a county,
  // because otherwise it takes the whole of Vancouver Island the moment its
  // neighbours are held to their own.
  Victoria: [-124.4, 48.2, -123.0, 49.0],
  Sunshine: [-125.0, 49.2, -123.2, 50.3],
  'Brittania Beach': [-123.5, 49.4, -122.5, 50.3],
  'Golden Ears': [-123.0, 49.0, -121.9, 50.0],
  Thompson: [-122.4, 49.0, -120.3, 50.3],
  Whatcom: [-122.9, 48.5, -121.7, 49.3],
  'Great Sauk': [-122.4, 48.1, -120.3, 49.2],
  Snohomish: [-122.6, 47.85, -121.5, 48.6],
  'Silver Sauk': [-122.3, 47.4, -120.3, 48.4],
  Clallam: [-125.2, 47.0, -122.9, 48.6],
  Jeffsin: [-123.3, 47.6, -122.4, 48.4],
  Hood: [-123.4, 47.2, -122.6, 48.0],
  Kitsap: [-123.0, 47.2, -122.4, 48.0],
  Mercer: [-122.4, 47.4, -121.8, 47.9],
  King: [-122.4, 47.0, -121.0, 47.9],
  Squaxin: [-123.7, 46.7, -122.6, 47.5],
  Pierce: [-123.2, 46.2, -121.8, 47.2],
  Rainier: [-122.4, 46.2, -120.3, 47.3],
};

/**
 * The ground each realm of the Texas and Western Gulfcoast plate is drawn on.
 *
 * The same device as `SALISH_GROUND`, for the same reason and at a different
 * scale. This plate is not a ring of city-states on an inland sea but thirty
 * realms across nineteen degrees of longitude, and the ones with open country at
 * their backs are exactly the ones that will not stay put: Comancheria seeded on
 * the caprock has nothing between it and the Rockies, and the Louisiane grown
 * from Alexandria will take east Texas to the Pecos if the realms drawn there
 * are not the ones holding it.
 *
 * Boxes are cut to what the plate shows rather than to any modern boundary, and
 * they overlap freely — a box says where a realm was drawn, not where its
 * frontier falls. Where two overlap the lattice settles it, which is what keeps
 * the Balcones escarpment and the piney woods looking like ground rather than
 * like the edges of rectangles.
 */
const TEXAS_GROUND: Record<string, [number, number, number, number]> = {
  // The desert west and the high plains.
  'Nuevo México': [-107.6, 33.4, -103.2, 37.3],
  'The Saucers': [-106.4, 31.4, -102.8, 35.0],
  Transpecos: [-106.8, 28.6, -101.6, 32.6],
  Amarillo: [-104.2, 33.8, -99.4, 37.2],
  Chisholm: [-103.4, 36.0, -95.0, 41.0],
  Comancheria: [-103.8, 30.2, -97.6, 35.4],

  // The Cross Timbers and the Hill Country.
  Metroplex: [-98.6, 31.7, -95.8, 34.0],
  'First Cavalry': [-99.8, 30.5, -96.4, 32.6],
  Longhorn: [-100.4, 29.3, -96.8, 31.2],
  Brazos: [-97.8, 29.5, -95.2, 31.6],
  Airmen: [-100.4, 27.4, -96.6, 30.1],
  Aggies: [-97.0, 28.6, -94.4, 30.6],
  Galveston: [-95.5, 28.8, -94.2, 29.9],

  // South to the river, and over it.
  'Rio Bravo': [-101.0, 25.2, -97.2, 28.6],
  'Nueva Extremadura': [-102.4, 27.2, -99.2, 30.2],
  Coahuila: [-104.6, 25.6, -100.2, 29.6],

  // The Ozarks and the country north of the Red River.
  Sequoyah: [-97.8, 33.4, -93.7, 37.2],
  Verdigris: [-97.8, 36.0, -94.2, 38.8],
  Salem: [-95.2, 35.7, -90.8, 38.8],
  'Great River': [-91.4, 36.2, -88.8, 38.4],
  'Little Egypt': [-89.9, 36.3, -87.6, 38.4],
  Tenesi: [-90.2, 34.3, -87.4, 36.8],
  Snowbirds: [-90.8, 33.5, -88.2, 35.4],

  // The lower Mississippi and the coast to the delta.
  Arkansas: [-94.8, 32.8, -90.2, 36.8],
  Texarkana: [-95.6, 32.3, -92.8, 34.4],
  'Little Mo': [-94.4, 32.2, -91.4, 34.2],
  Yazoo: [-91.6, 31.6, -89.4, 34.4],
  Natchez: [-92.0, 30.4, -89.2, 32.6],
  Louisiane: [-95.4, 28.9, -90.6, 33.4],
  'Nouvelle-Orléans': [-91.6, 28.8, -88.9, 30.9],
};

const EMPIRES: Empire[] = [
  {
    name: 'Empire of Cascadia',
    short: 'CASCADIA',
    type: 'empire',
    color: M[1],
    label: [-131, 55],
    realms: [
      { name: 'Duchy of Portlandia', short: 'Portlandia', type: 'duchy', seat: [-122.68, 45.52], weight: 0.5, capital: true },
      { name: 'Kingdom of Lincoln', short: 'Lincoln', type: 'kingdom', seat: [-123.09, 44.05], weight: 0.9 },
      { name: 'Petty Kingdom of the Okanagan', short: 'Okanagan', type: 'kingdom', seat: [-119.5, 49.9], weight: 0.9 },
      { name: 'Kingdom of Haida Tlagaang', short: 'Haida Tlagaang', type: 'kingdom', seat: [-130.3, 54.3], weight: 1.3 },
      { name: 'Duchy of Juneau', short: 'Juneau', type: 'duchy', seat: [-134.42, 58.30], weight: 1.0 },
      { name: 'Chiefdom of Aknuqtluk', short: 'Aknuqtluk', type: 'tribal-confederacy', seat: [-149.9, 61.2], weight: 1.4 },
      { name: 'High Chiefdom of Clearwater', short: 'Clearwater', type: 'tribal-confederacy', seat: [-116.0, 46.4], weight: 0.8 },
    ],
  },
  {
    /**
     * The Salish Sea, after the plate of it (spec §64).
     *
     * Eight free cities on the water and the counties between them, which is
     * how that plate reads: a ring of city-states around an inland sea, each
     * with a county or two behind it and the mountains closing the map on both
     * sides. The cities are seated on the cities and given a short reach, so
     * they stay the compact things they are drawn as; the counties carry the
     * ground between them.
     *
     * None of these subdivides. A realm has to hold twenty thousand square
     * kilometres before the builder looks for towns to break it into, and
     * nothing here is a tenth of that — so the states on the map are the states
     * on the plate, which is the point of copying it.
     */
    name: 'The Salish Sea',
    short: 'SALISH SEA',
    type: 'confederation',
    color: M[2],
    label: [-122.6, 48.2],
    realms: [
      // The free cities of the sea itself, north to south.
      { name: 'Free City of Vancouver', short: 'Vancouver', type: 'city-state', seat: [-123.12, 49.28], weight: 0.45, capital: true, whole: true },
      { name: 'Free City of Bellingham', short: 'Bellingham', type: 'city-state', seat: [-122.48, 48.75], weight: 0.4, whole: true },
      { name: 'Free City of Victoria', short: 'Victoria', type: 'city-state', seat: [-123.37, 48.43], weight: 0.45, whole: true, bounds: SALISH_GROUND['Victoria'] },
      { name: 'Free City of Everett', short: 'Everett', type: 'city-state', seat: [-122.20, 47.98], weight: 0.35, whole: true },
      { name: 'Free City of Seattle', short: 'Seattle', type: 'city-state', seat: [-122.33, 47.61], weight: 0.4, whole: true },
      { name: 'Free City of Tacoma', short: 'Tacoma', type: 'city-state', seat: [-122.30, 47.19], weight: 0.4, whole: true },
      { name: 'Free City of Olympia', short: 'Olympia', type: 'city-state', seat: [-122.90, 47.04], weight: 0.35, whole: true },
      { name: 'Free City of Cosmopolis', short: 'Cosmopolis', type: 'city-state', seat: [-123.78, 46.98], weight: 0.5, whole: true },

      // The counties behind them, north to south. Weights are reach rather than
      // rank: the ones with mountains at their backs run further inland.
      { name: 'County of the Sunshine Coast', short: 'Sunshine', type: 'county', seat: [-123.76, 49.62], weight: 0.8, whole: true, bounds: SALISH_GROUND['Sunshine'] },
      { name: 'County of Brittania Beach', short: 'Brittania Beach', type: 'county', seat: [-123.16, 49.66], weight: 0.9, whole: true, bounds: SALISH_GROUND['Brittania Beach'] },
      { name: 'County of Golden Ears', short: 'Golden Ears', type: 'county', seat: [-122.45, 49.32], weight: 0.9, whole: true, bounds: SALISH_GROUND['Golden Ears'] },
      { name: 'County of Thompson', short: 'Thompson', type: 'county', seat: [-121.50, 49.45], weight: 1.1, whole: true, bounds: SALISH_GROUND['Thompson'] },
      { name: 'County of Whatcom', short: 'Whatcom', type: 'county', seat: [-122.25, 48.94], weight: 0.8, whole: true, bounds: SALISH_GROUND['Whatcom'] },
      { name: 'County of the Great Sauk', short: 'Great Sauk', type: 'county', seat: [-121.60, 48.55], weight: 1.2, whole: true, bounds: SALISH_GROUND['Great Sauk'] },
      { name: 'County of Snohomish', short: 'Snohomish', type: 'county', seat: [-122.05, 48.28], weight: 0.7, whole: true, bounds: SALISH_GROUND['Snohomish'] },
      { name: 'County of the Silver Sauk', short: 'Silver Sauk', type: 'county', seat: [-121.55, 47.95], weight: 1.1, whole: true, bounds: SALISH_GROUND['Silver Sauk'] },
      { name: 'County of Clallam', short: 'Clallam', type: 'county', seat: [-123.60, 48.05], weight: 1.0, whole: true, bounds: SALISH_GROUND['Clallam'] },
      { name: 'County of Jeffsin', short: 'Jeffsin', type: 'county', seat: [-122.85, 47.95], weight: 0.6, whole: true, bounds: SALISH_GROUND['Jeffsin'] },
      { name: 'County of Hood', short: 'Hood', type: 'county', seat: [-123.02, 47.55], weight: 0.7, whole: true, bounds: SALISH_GROUND['Hood'] },
      { name: 'County of Kitsap', short: 'Kitsap', type: 'county', seat: [-122.68, 47.45], weight: 0.5, whole: true, bounds: SALISH_GROUND['Kitsap'] },
      { name: 'County of Mercer', short: 'Mercer', type: 'county', seat: [-122.08, 47.62], weight: 0.5, whole: true, bounds: SALISH_GROUND['Mercer'] },
      { name: 'County of King', short: 'King', type: 'county', seat: [-121.95, 47.38], weight: 1.0, whole: true, bounds: SALISH_GROUND['King'] },
      { name: 'County of Squaxin', short: 'Squaxin', type: 'county', seat: [-123.12, 47.22], weight: 0.7, whole: true, bounds: SALISH_GROUND['Squaxin'] },
      { name: 'County of Pierce', short: 'Pierce', type: 'county', seat: [-122.25, 46.95], weight: 0.8, whole: true, bounds: SALISH_GROUND['Pierce'] },
      { name: 'County of Rainier', short: 'Rainier', type: 'county', seat: [-121.75, 46.85], weight: 0.9, whole: true, bounds: SALISH_GROUND['Rainier'] },
    ],
  },
  {
    name: 'Celestial Empire of California',
    short: 'CALIFORNIA',
    type: 'empire',
    color: M[3],
    label: [-120.6, 36.2],
    realms: [
      { name: 'Kingdom of Jefferson', short: 'Jefferson', type: 'kingdom', seat: [-122.39, 40.59], weight: 0.8 },
      { name: 'Kingdom of Gran Francisco', short: 'Gran Francisco', type: 'kingdom', seat: [-122.42, 37.77], weight: 0.5, capital: true },
      { name: 'Kingdom of the Valley', short: 'The Valley', type: 'kingdom', seat: [-119.79, 36.75], weight: 0.7 },
      { name: 'Kingdom of Socal', short: 'Socal', type: 'kingdom', seat: [-118.24, 34.05], weight: 0.8 },
      { name: 'High Chiefdom of Death Valley', short: 'Death Valley', type: 'tribal-confederacy', seat: [-115.14, 36.17], weight: 0.9 },
      { name: 'Kingdom of Baja', short: 'Baja', type: 'kingdom', seat: [-110.31, 24.14], weight: 0.9, also: [[-115.5, 30.5]] },
    ],
  },
  {
    name: 'The Rockies',
    short: 'ROCKIES',
    type: 'confederation',
    color: M[2],
    label: [-110.5, 43.8],
    realms: [
      { name: 'Kingdom of Deseret', short: 'Deseret', type: 'kingdom', seat: [-111.89, 40.76], weight: 1.2, capital: true },
      { name: 'High Chiefdom of Northern Basin', short: 'Northern Basin', type: 'tribal-confederacy', seat: [-115.76, 40.83], weight: 0.9 },
      { name: 'High Chiefdom of West Snake', short: 'West Snake', type: 'tribal-confederacy', seat: [-116.20, 43.62], weight: 1.0 },
      { name: 'High Chiefdom of Silver Bow', short: 'Silver Bow', type: 'tribal-confederacy', seat: [-112.53, 46.00], weight: 0.9 },
      { name: 'High Chiefdom of Beartooth', short: 'Beartooth', type: 'tribal-confederacy', seat: [-108.50, 45.78], weight: 1.0 },
      { name: 'High Chiefdom of Highland Springs', short: 'Highland Springs', type: 'tribal-confederacy', seat: [-106.31, 42.85], weight: 1.0 },
      { name: 'High Chiefdom of Denver', short: 'Denver', type: 'tribal-confederacy', seat: [-104.99, 39.74], weight: 0.8 },
      { name: 'High Chiefdom of Pueblo', short: 'Pueblo', type: 'tribal-confederacy', seat: [-104.61, 38.25], weight: 0.7 },
    ],
  },
  {
    name: 'The Thunderlands',
    short: 'THUNDERLANDS',
    type: 'confederation',
    color: A[7],
    label: [-105, 53.5],
    realms: [
      { name: 'Kingdom of Lakotah', short: 'Lakotah', type: 'kingdom', seat: [-103.23, 44.08], weight: 1.4, capital: true },
      { name: 'High Chiefdom of Chouteau', short: 'Chouteau', type: 'tribal-confederacy', seat: [-111.30, 47.50], weight: 1.0 },
      { name: 'Petty Kingdom of Alberta', short: 'Alberta', type: 'kingdom', seat: [-114.07, 51.05], weight: 1.4 },
      { name: 'High Chiefdom of Ahtahkakoop', short: 'Ahtahkakoop', type: 'tribal-confederacy', seat: [-106.67, 52.13], weight: 1.4 },
      { name: 'High Chiefdom of Winnipeg', short: 'Winnipeg', type: 'tribal-confederacy', seat: [-97.14, 49.90], weight: 1.2 },
      { name: 'Jarldom of Sheyenne', short: 'Sheyenne', type: 'duchy', seat: [-96.79, 46.88], weight: 0.9 },
      { name: 'Jarldom of Pembina', short: 'Pembina', type: 'duchy', seat: [-97.03, 48.20], weight: 0.7 },
      { name: 'High Chiefdom of Keewatin', short: 'Keewatin', type: 'tribal-confederacy', seat: [-89.25, 48.38], weight: 1.2 },
      { name: 'High Chiefdom of Golden Valley', short: 'Golden Valley', type: 'tribal-confederacy', seat: [-102.79, 47.28], weight: 0.8 },
    ],
  },
  {
    name: 'The Great Lakes',
    short: 'GREAT LAKES',
    type: 'confederation',
    color: A[5],
    label: [-88.5, 46.9],
    realms: [
      { name: 'Duchy of Cook', short: 'Cook', type: 'duchy', seat: [-87.63, 41.88], weight: 0.45, capital: true },
      { name: 'Petty Kingdom of Illinois', short: 'Illinois', type: 'kingdom', seat: [-89.65, 39.80], weight: 0.8 },
      { name: 'Jarldom of the Northwoods', short: 'Northwoods', type: 'duchy', seat: [-92.10, 46.79], weight: 0.9 },
      { name: 'Republic of Superior', short: 'Superior', type: 'republic', seat: [-90.19, 46.60], weight: 0.6 },
      { name: 'Jarldom of Copperland', short: 'Copperland', type: 'duchy', seat: [-87.40, 46.55], weight: 0.7 },
      { name: 'Jarldom of Green Bay', short: 'Green Bay', type: 'duchy', seat: [-88.02, 44.51], weight: 0.7 },
      { name: 'Jarldom of Chippewa', short: 'Chippewa', type: 'duchy', seat: [-91.50, 44.81], weight: 0.7 },
      { name: 'Factory of Detroit', short: 'Detroit', type: 'city-state', seat: [-83.05, 42.33], weight: 0.5 },
      { name: 'Duchy of the Wilds', short: 'The Wilds', type: 'duchy', seat: [-85.62, 44.76], weight: 0.7 },
      { name: 'Petty Tycoonship of Indianapolis', short: 'Indianapolis', type: 'city-state', seat: [-86.16, 39.77], weight: 0.6 },
      { name: 'Petty Commonwealth of Zinzinnati', short: 'Zinzinnati', type: 'republic', seat: [-84.51, 39.10], weight: 0.6 },
      { name: 'Tribe of Burning River', short: 'Burning River', type: 'tribal-confederacy', seat: [-81.69, 41.50], weight: 0.7 },
      { name: 'Oligarchy of Niagara', short: 'Niagara', type: 'republic', seat: [-78.88, 42.89], weight: 0.5 },
    ],
  },
  {
    name: 'The Heartland',
    short: 'HEARTLAND',
    type: 'confederation',
    color: A[1],
    label: [-97.8, 40.2],
    realms: [
      { name: 'Republic of Boonslick', short: 'Boonslick', type: 'republic', seat: [-92.33, 38.95], weight: 0.9 },
      { name: 'The Papacy', short: 'The Papacy', type: 'theocracy', seat: [-90.20, 38.63], weight: 0.5, capital: true },
      { name: 'Kingdom of Iowa', short: 'Iowa', type: 'kingdom', seat: [-93.62, 41.59], weight: 1.0 },
      { name: 'Kingdom of Platte', short: 'Platte', type: 'kingdom', seat: [-96.50, 41.10], weight: 1.2 },
      { name: 'Grand Division of Lead Belt', short: 'Lead Belt', type: 'province', seat: [-90.60, 37.30], weight: 0.6 },

      // The top of the Texas plate: the cattle trail across the short-grass
      // plains, and the Ozark realms east of it. Chisholm moves off Wichita and
      // onto the trail itself, which is where the plate draws it.
      { name: 'Duchy of Chisholm', short: 'Chisholm', type: 'duchy', seat: [-100.02, 37.75], weight: 0.9, whole: true, bounds: TEXAS_GROUND['Chisholm'] },
      { name: 'Duchy of Verdigris', short: 'Verdigris', type: 'duchy', seat: [-95.71, 37.22], weight: 0.7, whole: true, bounds: TEXAS_GROUND['Verdigris'] },
      { name: 'Republic of Salem', short: 'Salem', type: 'republic', seat: [-93.29, 37.21], weight: 1.0, whole: true, bounds: TEXAS_GROUND['Salem'] },
      { name: 'Duchy of the Great River', short: 'Great River', type: 'duchy', seat: [-90.39, 36.76], weight: 0.7, whole: true, bounds: TEXAS_GROUND['Great River'] },
      { name: 'Duchy of Little Egypt', short: 'Little Egypt', type: 'duchy', seat: [-88.73, 37.15], weight: 0.6, whole: true, bounds: TEXAS_GROUND['Little Egypt'] },
    ],
  },
  {
    /**
     * Texas and the western Gulfcoast, after the plate of it (spec §64).
     *
     * The second plate this map is copied from, and a different problem from the
     * Salish Sea. That one was small enough that a realm could be held in place
     * by its neighbours; this one is a continent's worth of open country, where
     * a realm with the Llano Estacado at its back grows until the coverage
     * budget stops it. Every realm here is bounded to the ground the plate drew
     * it on, and none of them subdivides — the plate's own names are the answer,
     * and Comancheria broken into four counties named after towns would not be
     * Comancheria.
     *
     * The march of them across the plate: the desert realms in the west, the
     * high plains above the caprock, the Cross Timbers and the Hill Country
     * through the middle, the Balcones towns on the coastal plain, and the river
     * realms east of the Sabine. The forts are states in their own right, which
     * is how that plate reads a collapsed republic: whoever held the armoury
     * held the county.
     */
    name: 'Texas and the Western Gulfcoast',
    short: 'LONE STAR',
    type: 'kingdom',
    color: A[6],
    label: [-101.5, 31.4],
    realms: [
      // The high plains and the desert west.
      { name: 'Kingdom of Comancheria', short: 'Comancheria', type: 'kingdom', seat: [-101.86, 33.58], weight: 1.3, capital: true, whole: true, bounds: TEXAS_GROUND['Comancheria'] },
      { name: 'Duchy of Amarillo', short: 'Amarillo', type: 'duchy', seat: [-101.83, 35.22], weight: 1.0, whole: true, bounds: TEXAS_GROUND['Amarillo'] },
      { name: 'Duchy of Transpecos', short: 'Transpecos', type: 'duchy', seat: [-103.06, 30.90], weight: 1.1, whole: true, bounds: TEXAS_GROUND['Transpecos'] },
      { name: 'Tribe of the Saucers', short: 'The Saucers', type: 'tribal-confederacy', seat: [-104.52, 33.39], weight: 1.0, whole: true, bounds: TEXAS_GROUND['The Saucers'] },

      // The Cross Timbers, the forts, and the Hill Country.
      { name: 'Duchy of Metroplex', short: 'Metroplex', type: 'city-state', seat: [-97.33, 32.75], weight: 0.7, whole: true, bounds: TEXAS_GROUND['Metroplex'] },
      { name: 'The First Cavalry', short: 'First Cavalry', type: 'march', seat: [-97.78, 31.13], weight: 0.8, whole: true, bounds: TEXAS_GROUND['First Cavalry'] },
      { name: 'Longhorn Realm', short: 'Longhorn', type: 'duchy', seat: [-97.74, 30.27], weight: 1.0, whole: true, bounds: TEXAS_GROUND['Longhorn'] },
      { name: 'Duchy of Brazos', short: 'Brazos', type: 'duchy', seat: [-96.31, 30.63], weight: 0.7, whole: true, bounds: TEXAS_GROUND['Brazos'] },

      // The coastal plain, from the Nueces to Galveston Bay.
      { name: 'Tribe of Airmen', short: 'Airmen', type: 'tribal-confederacy', seat: [-98.49, 29.42], weight: 0.9, whole: true, bounds: TEXAS_GROUND['Airmen'] },
      { name: 'Duchy of Aggies', short: 'Aggies', type: 'duchy', seat: [-96.54, 29.71], weight: 0.8, also: [[-95.37, 29.76]], whole: true, bounds: TEXAS_GROUND['Aggies'] },
      { name: 'Free City of Galveston', short: 'Galveston', type: 'city-state', seat: [-94.80, 29.30], weight: 0.35, whole: true, bounds: TEXAS_GROUND['Galveston'] },

      // South to the river. The realm on the Rio Bravo takes its name, so the
      // one seated at Chihuahua is under the name of its own city.
      { name: 'Kingdom of Rio Bravo', short: 'Rio Bravo', type: 'kingdom', seat: [-99.51, 27.51], weight: 1.0, whole: true, bounds: TEXAS_GROUND['Rio Bravo'] },

      // The Cherokee country north of the Red River.
      { name: 'Duchy of Sequoyah', short: 'Sequoyah', type: 'duchy', seat: [-95.99, 36.15], weight: 1.0, whole: true, bounds: TEXAS_GROUND['Sequoyah'] },
      { name: 'Duchy of Texarkana', short: 'Texarkana', type: 'duchy', seat: [-94.05, 33.44], weight: 0.7, whole: true, bounds: TEXAS_GROUND['Texarkana'] },
    ],
  },
  {
    name: 'The Gulfcoast',
    short: 'GULFCOAST',
    type: 'confederation',
    color: A[8],
    label: [-92.6, 35.6],
    realms: [
      // The river realms of the plate. Louisiane is seated at Alexandria rather
      // than Baton Rouge because the plate gives the delta to the city on it.
      { name: 'Kingdom of Louisiane', short: 'Louisiane', type: 'kingdom', seat: [-92.45, 31.31], weight: 1.2, capital: true, whole: true, bounds: TEXAS_GROUND['Louisiane'] },
      { name: 'Republic of Nouvelle-Orléans', short: 'Nouvelle-Orléans', type: 'republic', seat: [-90.07, 29.95], weight: 0.5, whole: true, bounds: TEXAS_GROUND['Nouvelle-Orléans'] },
      { name: 'Duchy of Little Mo', short: 'Little Mo', type: 'duchy', seat: [-92.66, 33.21], weight: 0.6, whole: true, bounds: TEXAS_GROUND['Little Mo'] },
      { name: 'Duchy of Arkansas', short: 'Arkansas', type: 'duchy', seat: [-92.29, 34.75], weight: 1.1, whole: true, bounds: TEXAS_GROUND['Arkansas'] },
      { name: 'Duchy of Mobile', short: 'Mobile', type: 'duchy', seat: [-88.04, 30.69], weight: 0.7 },
    ],
  },
  {
    name: 'Holy Columbian Confederacy',
    short: 'HOLY COLUMBIA',
    type: 'confederation',
    color: A[2],
    label: [-83.4, 32.2],
    realms: [
      { name: 'Metropolis of Choctaw', short: 'Choctaw', type: 'city-state', seat: [-84.39, 33.75], weight: 0.9, capital: true },
      // The plate's right-hand edge: the Delta realms, and the two the
      // Mississippi divides from Tenesi.
      { name: 'Duchy of Yazoo', short: 'Yazoo', type: 'duchy', seat: [-90.65, 33.45], weight: 0.8, whole: true, bounds: TEXAS_GROUND['Yazoo'] },
      { name: 'District of Natchez', short: 'Natchez', type: 'district', seat: [-91.40, 31.56], weight: 0.7, whole: true, bounds: TEXAS_GROUND['Natchez'] },
      { name: 'Duchy of Tenesi', short: 'Tenesi', type: 'duchy', seat: [-88.81, 35.61], weight: 0.9, whole: true, bounds: TEXAS_GROUND['Tenesi'] },
      { name: 'Duchy of the Snowbirds', short: 'Snowbirds', type: 'duchy', seat: [-89.52, 34.37], weight: 0.7, whole: true, bounds: TEXAS_GROUND['Snowbirds'] },
      { name: 'Kingdom of Carolina', short: 'Carolina', type: 'kingdom', seat: [-79.94, 32.78], weight: 0.9 },
      { name: 'Duchy of Suwannee', short: 'Suwannee', type: 'duchy', seat: [-84.28, 30.44], weight: 0.7 },
      { name: 'Principality of Orlando', short: 'Orlando', type: 'principality', seat: [-81.38, 28.54], weight: 0.6 },
      { name: 'Republic of Millami', short: 'Millami', type: 'republic', seat: [-80.19, 25.77], weight: 0.5 },
    ],
  },
  {
    name: 'Grand Virginia',
    short: 'GRAND VIRGINIA',
    type: 'confederation',
    color: A[4],
    label: [-81.8, 36.9],
    realms: [
      { name: 'Republic of Chesapeake', short: 'Chesapeake', type: 'republic', seat: [-77.44, 37.54], weight: 0.8, capital: true },
      { name: 'High Chiefdom of Vandalia', short: 'Vandalia', type: 'tribal-confederacy', seat: [-81.63, 38.35], weight: 0.8 },
      { name: 'High Chiefdom of Blue Ridge', short: 'Blue Ridge', type: 'tribal-confederacy', seat: [-82.55, 35.60], weight: 0.7 },
      { name: 'Grand Division of Bluegrass', short: 'Bluegrass', type: 'province', seat: [-84.50, 38.05], weight: 0.8 },
      { name: 'Grand Division of East Tennessee', short: 'East Tennessee', type: 'province', seat: [-83.92, 35.96], weight: 0.7 },
      { name: 'High Chiefdom of Cumberland', short: 'Cumberland', type: 'tribal-confederacy', seat: [-86.78, 36.16], weight: 0.8 },
    ],
  },
  {
    name: 'Empire of Atlantica',
    short: 'ATLANTICA',
    type: 'empire',
    color: A[3],
    label: [-67.5, 46.6],
    realms: [
      { name: 'Republic of New York', short: 'New York', type: 'republic', seat: [-74.01, 40.71], weight: 0.35, capital: true },
      { name: 'Kingdom of Hudsonia', short: 'Hudsonia', type: 'kingdom', seat: [-73.76, 42.65], weight: 0.9 },
      { name: 'Kingdom of Deitschrei', short: 'Deitschrei', type: 'kingdom', seat: [-76.31, 40.04], weight: 0.9 },
      { name: 'District of Philadelphia', short: 'Philadelphia', type: 'district', seat: [-75.17, 39.95], weight: 0.35 },
      { name: 'District of South Jersey', short: 'South Jersey', type: 'district', seat: [-74.75, 39.45], weight: 0.4 },
      { name: 'District Court of Columbia', short: 'Columbia', type: 'district', seat: [-77.04, 38.91], weight: 0.4 },
      { name: 'District of Delmarva', short: 'Delmarva', type: 'district', seat: [-75.60, 38.35], weight: 0.4 },
      { name: 'District of Connecticut', short: 'Connecticut', type: 'district', seat: [-72.69, 41.76], weight: 0.5 },
      { name: 'Chiefdom of Plymouth', short: 'Plymouth', type: 'tribal-confederacy', seat: [-70.66, 41.96], weight: 0.5 },
      { name: 'Duchy of the Green Mountains', short: 'Green Mountains', type: 'duchy', seat: [-72.58, 44.26], weight: 0.7 },
      { name: 'High Chiefdom of Penobscot', short: 'Penobscot', type: 'tribal-confederacy', seat: [-68.78, 44.80], weight: 0.9 },
      { name: 'County of the Triple Cities', short: 'Triple Cities', type: 'county', seat: [-75.91, 42.10], weight: 0.4 },
    ],
  },
  {
    name: 'Empire of Canada',
    short: 'CANADA',
    type: 'empire',
    color: A[0],
    label: [-79.0, 51.5],
    realms: [
      { name: 'Ursuline See', short: 'Ursuline See', type: 'theocracy', seat: [-71.21, 46.81], weight: 1.1, capital: true },
      { name: 'Duchy of Montréal', short: 'Montréal', type: 'duchy', seat: [-73.57, 45.50], weight: 0.5 },
      { name: 'Kingdom of Ontario', short: 'Ontario', type: 'kingdom', seat: [-79.38, 43.65], weight: 1.0 },
      { name: 'Archbishopric of Canterbury', short: 'Canterbury', type: 'bishopric', seat: [-81.25, 42.98], weight: 0.5 },
      { name: 'Duchy of Nipissing', short: 'Nipissing', type: 'duchy', seat: [-79.46, 46.31], weight: 0.9 },
      { name: 'Duchy of Algoma', short: 'Algoma', type: 'duchy', seat: [-84.33, 46.52], weight: 0.9 },
      { name: 'Duchy of Saguenay', short: 'Saguenay', type: 'duchy', seat: [-71.07, 48.43], weight: 0.9 },
      { name: 'Kingdom of the Maritimes', short: 'Maritimes', type: 'kingdom', seat: [-63.57, 44.65], weight: 1.0 },
      { name: 'County of Gaspé', short: 'Gaspé', type: 'county', seat: [-64.48, 48.83], weight: 0.5 },
    ],
  },
  {
    name: 'The Arctic',
    short: 'ARCTIC',
    type: 'confederation',
    color: A[9],
    label: [-88, 60],
    realms: [
      { name: 'High Chiefdom of Eeyou Istchee', short: 'Eeyou Istchee', type: 'tribal-confederacy', seat: [-78.80, 53.79], weight: 1.6, capital: true },
      { name: 'High Chiefdom of Mushkegowuk', short: 'Mushkegowuk', type: 'tribal-confederacy', seat: [-82.43, 51.28], weight: 1.2 },
      { name: 'Chiefdom of Kuujjuaq', short: 'Kuujjuaq', type: 'tribal-confederacy', seat: [-68.42, 58.10], weight: 1.4 },
      { name: 'High Chiefdom of Nunatsiavut', short: 'Nunatsiavut', type: 'tribal-confederacy', seat: [-61.69, 56.54], weight: 1.2 },
      { name: 'Petty Kingdom of Avalon', short: 'Avalon', type: 'kingdom', seat: [-52.71, 47.56], weight: 0.9 },
    ],
  },
  {
    name: 'Aztlán',
    short: 'AZTLÁN',
    type: 'confederation',
    color: M[0],
    label: [-108.8, 27.0],
    realms: [
      { name: 'Kingdom of Diné Bikéyah', short: 'Diné Bikéyah', type: 'kingdom', seat: [-109.05, 35.68], weight: 1.1, capital: true },
      { name: 'Chiefdom of Phoenix', short: 'Phoenix', type: 'tribal-confederacy', seat: [-112.07, 33.45], weight: 0.7 },
      { name: 'High Chiefdom of Gadsden', short: 'Gadsden', type: 'tribal-confederacy', seat: [-110.93, 32.22], weight: 0.8 },
      { name: 'High Chiefdom of the Colorado', short: 'The Colorado', type: 'tribal-confederacy', seat: [-114.62, 32.73], weight: 0.7 },
      { name: 'High Chiefdom of Nuevo México', short: 'Nuevo México', type: 'tribal-confederacy', seat: [-105.94, 35.69], weight: 1.0, whole: true, bounds: TEXAS_GROUND['Nuevo México'] },
      { name: 'Duchy of Sonora', short: 'Sonora', type: 'duchy', seat: [-110.97, 29.07], weight: 1.1 },
      // Named for its city, not for the river: the plate gives "Rio Bravo" to
      // the realm actually seated on it, four hundred miles downstream.
      { name: 'Kingdom of Chihuahua', short: 'Chihuahua', type: 'kingdom', seat: [-106.09, 28.63], weight: 1.2 },
      { name: 'Duchy of Nueva Extremadura', short: 'Nueva Extremadura', type: 'duchy', seat: [-100.52, 28.70], weight: 0.9, whole: true, bounds: TEXAS_GROUND['Nueva Extremadura'] },
      { name: 'Duchy of Coahuila', short: 'Coahuila', type: 'duchy', seat: [-101.51, 27.88], weight: 1.0, whole: true, bounds: TEXAS_GROUND['Coahuila'] },
      { name: 'Kingdom of Sierra Madre', short: 'Sierra Madre', type: 'kingdom', seat: [-104.67, 24.02], weight: 1.0 },
      { name: 'Duchy of Sinaloa', short: 'Sinaloa', type: 'duchy', seat: [-107.39, 24.80], weight: 0.8 },
    ],
  },
  {
    name: 'Empire of Mexico',
    short: 'MEXICO',
    type: 'empire',
    color: M[4],
    label: [-103.6, 21.0],
    realms: [
      { name: 'Kingdom of Mexico', short: 'Mexico', type: 'kingdom', seat: [-99.13, 19.43], weight: 0.8, capital: true },
      { name: 'Duchy of Salado', short: 'Salado', type: 'duchy', seat: [-100.31, 25.67], weight: 1.0 },
      { name: 'Duchy of San Luis Potosí', short: 'San Luis Potosí', type: 'duchy', seat: [-100.98, 22.15], weight: 0.8 },
      { name: 'Duchy of Zacatecas', short: 'Zacatecas', type: 'duchy', seat: [-102.58, 22.77], weight: 0.7 },
      { name: 'Duchy of Jalisco', short: 'Jalisco', type: 'duchy', seat: [-103.35, 20.66], weight: 0.8 },
      { name: 'Duchy of Nayarit', short: 'Nayarit', type: 'duchy', seat: [-104.89, 21.51], weight: 0.6 },
      { name: 'Kingdom of Michoacán', short: 'Michoacán', type: 'kingdom', seat: [-101.19, 19.70], weight: 0.7 },
      { name: 'Kingdom of Mixteca', short: 'Mixteca', type: 'kingdom', seat: [-96.73, 17.07], weight: 0.8 },
      { name: 'Republic of Veracruz', short: 'Veracruz', type: 'republic', seat: [-96.13, 19.17], weight: 0.7 },
      { name: 'Duchy of Olmeca', short: 'Olmeca', type: 'duchy', seat: [-92.93, 17.99], weight: 0.6 },
    ],
  },
  {
    name: 'Yucatán',
    short: 'YUCATÁN',
    type: 'kingdom',
    color: M[5],
    label: [-88.6, 19.0],
    realms: [
      { name: 'Kingdom of Yucatán', short: 'Yucatán', type: 'kingdom', seat: [-89.62, 20.97], weight: 0.8, capital: true },
      { name: 'Captaincy of Cozumel', short: 'Cozumel', type: 'march', seat: [-86.92, 20.51], weight: 0.4 },
      { name: 'Ajawil of Chiapas', short: 'Chiapas', type: 'principality', seat: [-93.12, 16.75], weight: 0.6 },
    ],
  },
];

/** Seas, gulfs and the one range the Salish plate names (§12). */
const WATER_LABELS: { text: string; lon: number; lat: number; kind: MapLabel['kind'] }[] = [
  { text: 'Atlantic Ocean', lon: -45, lat: 33, kind: 'ocean' },
  { text: 'Pacific Ocean', lon: -140, lat: 27, kind: 'ocean' },
  { text: 'Gulf of Mexico', lon: -90.5, lat: 25.2, kind: 'water' },
  { text: 'Caribbean Sea', lon: -75.5, lat: 14.5, kind: 'water' },
  { text: 'Hudson Bay', lon: -85.5, lat: 59.5, kind: 'water' },
  { text: 'Gulf of Alaska', lon: -146, lat: 56.5, kind: 'water' },
  { text: 'Labrador Sea', lon: -55.5, lat: 59.5, kind: 'water' },
  { text: 'Gulf of California', lon: -111.5, lat: 27.5, kind: 'water' },
  { text: 'The Sea of Victoria', lon: -123.55, lat: 49.15, kind: 'water' },
  { text: 'Sea of Won-di-Fook', lon: -124.1, lat: 48.3, kind: 'water' },
  { text: 'The Salish Sea', lon: -122.55, lat: 47.75, kind: 'water' },
  { text: 'The Olympic Mountains', lon: -123.55, lat: 47.75, kind: 'mountain' },
];

export interface AfterTheEndResult {
  /**
   * True when this came off disk rather than out of the generator, so the
   * caller knows the view in the file is a decision somebody made and not a
   * default to be improved on.
   */
  saved?: boolean;
  project: MapProject;
  center: [number, number];
  zoom: number;
}

const CENTER: [number, number] = [-100, 40];
const ZOOM = 2.6;
/** The New World, with sea room. Nothing outside it is loaded or drawable. */
const AMERICAS: [number, number, number, number] = [-172, -58, -30, 76];

/**
 * The ground the realms are grown on: North America down to Mexico's southern
 * border, and no further.
 *
 * The setting's realms stop there, and so does the growth — a realm grows until
 * it meets another or runs out of land, so with nothing seeded beyond it the
 * Mexican and Yucatec crowns would simply keep going and take Central America
 * and the isthmus between them. Cutting the land is what makes the border a
 * shore as far as the growth is concerned.
 *
 * The edge traces borders rather than lines of latitude, because a rectangle
 * anywhere here costs something real: drawn along Chiapas it takes the Yucatán
 * off, and drawn along the Yucatán it hands over Guatemala. So it runs up the
 * Guatemalan border from the Pacific, along the Belizean line to Chetumal, out
 * through the channel between the Yucatán and Cuba, and then east between the
 * Florida Keys and the Bahamas.
 *
 * The land beyond it is still drawn — it is the same coastline it always was —
 * it simply belongs to nobody.
 */
const ANGLO_AMERICA: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-180, 14.0], // open Pacific, south of everything Mexican
      [-95.0, 14.0],
      [-92.25, 14.53], // where the Guatemalan border meets the Pacific
      [-91.2, 15.1],
      [-90.45, 16.07],
      [-91.0, 16.2],
      [-90.99, 17.82], // north up the Usumacinta
      [-89.14, 17.82], // the Guatemala–Belize tripoint
      [-89.14, 18.49],
      [-88.3, 18.49], // Chetumal Bay, and out into the Caribbean
      [-86.5, 18.3],
      [-85.7, 20.5], // the channel: east of Cozumel, west of Cuba
      [-85.5, 23.0],
      [-84.0, 24.0], // north of Cuba
      [-81.5, 24.3], // south of the Dry Tortugas
      [-80.0, 25.0], // south of the Keys
      [-79.0, 26.0],
      [-78.5, 27.5], // west of Grand Bahama
      [-75.0, 30.0],
      [-20, 30],
      [-20, 85],
      [-180, 85],
      [-180, 14.0],
    ],
  ],
};

/** The box the growth lattice covers: the mask above, and nothing below it. */
const NORTH_AMERICA: [number, number, number, number] = [-172, 13, -30, 76];

/**
 * Build the map. Async because it fetches the real coastline to grow on;
 * returns an empty project if that fetch fails, rather than a half-built one.
 */
/**
 * Where the finished map is kept, relative to the document.
 *
 * Document-relative for the same reason the geography is: Pages serves this
 * from a sub-path.
 */
const SAVED_MAP = 'data/after-the-end.atfmap';

/**
 * The After the End map as it was last drawn (spec §49, §65).
 *
 * The generator below builds this map from seats and weights, which is how it
 * came to exist and what makes it reproducible — but it is also thirteen
 * seconds of lattice growth, subdivision and colouring before anything appears,
 * and it cannot know about anything done to the map by hand since. A saved file
 * has neither problem: it is the map as it actually stands, edits and all, and
 * reading it is a parse.
 *
 * The generator stays as the fallback, so a missing or unreadable file costs
 * the wait rather than the map.
 */
export async function loadAfterTheEndProject(): Promise<AfterTheEndResult> {
  try {
    const res = await fetch(SAVED_MAP);
    if (!res.ok) throw new Error(`${res.status}`);
    const project = deserializeProject(await res.text());
    return { project, saved: true, center: project.view.center as [number, number], zoom: project.view.zoom };
  } catch {
    return buildAfterTheEndProject();
  }
}

export async function buildAfterTheEndProject(): Promise<AfterTheEndResult> {
  const project = createProject({
    title: 'After the End',
    projectionId: 'ATF:AMERICAS',
    center: CENTER,
    zoom: ZOOM,
    workingExtent: AMERICAS,
  });
  project.meta.subtitle = 'The realms of North America';
  project.meta.dateLine = 'In the Year 2666';
  project.meta.author = 'After the Fall — a map of the After the End setting';
  project.meta.notes =
    'Realm names, their tier and the empire each belongs to follow the After the End realm list. ' +
    'The shapes are grown outward from each realm\'s seat of power rather than traced from modern ' +
    'administrative boundaries, and the land nobody claimed is left as wilderness. The plate covers ' +
    'North America down to Mexico\'s southern border; the isthmus, the Caribbean and South America ' +
    'are drawn but unclaimed. Every border is an ordinary editable territory.';
  project.oceanColor = '#c6dae6';
  project.landColor = '#eae3d3';
  // The Americas at Natural Earth's finest published scale — coastline, inland
  // water, rivers and cities — all cropped to the working extent above.
  project.basemap = [
    { sourceId: 'world-land-10m', visible: true, opacity: 1 },
    { sourceId: 'world-lakes-10m', visible: true, opacity: 1 },
    { sourceId: 'world-rivers-10m', visible: true, opacity: 1 },
    // The highway network of the old world, still there to be travelled: the
    // interstates and national routes, drawn under the cities and over the
    // rivers they bridge.
    { sourceId: 'world-roads-10m', visible: true, opacity: 1 },
    // Real cities on, under the map's own thirty capitals. They draw as quiet
    // hollow dots with grey names and are filtered by Natural Earth's
    // scalerank, so a continental view shows the handful that carry it and the
    // rest arrive as you zoom — the surviving population of the old world, for
    // the realms above to be seated among.
    { sourceId: 'world-places-10m', visible: true, opacity: 1 },
    { sourceId: 'na-admin1-10m', visible: false, opacity: 1 },
  ];

  const territoryLayer = findLayerByKind(project, 'territory')!;
  const settlementLayer = findLayerByKind(project, 'settlement')!;
  const countryLabels = Object.values(project.layers).find((l) => l.name === 'Country Labels')!;
  const cityLabels = Object.values(project.layers).find((l) => l.name === 'City Labels')!;
  const waterLabels = Object.values(project.layers).find((l) => l.name === 'Water Labels')!;

  // Every realm is named, vassals included. That layer used to start hidden,
  // and with good reason: a hundred and fifty realm names under thirty empire
  // names was a mat, and §11 never drops a label on its own. It is not that map
  // any more — only fifty-seven realms are vassals now, the other hundred and
  // thirty are sovereign and already carry their names, and a chiefdom inside
  // an empire has as much right to be named as a duchy outside one. Hiding it
  // meant a realm like the Chiefdom of Plymouth appeared on the map with no
  // name at all.
  //
  // Capital names do still start off: thirty of them sit on top of the realm
  // names, saying much the same thing twice, and the City Labels layer is one
  // click away for whoever wants them.
  project.layers[cityLabels.id] = { ...project.layers[cityLabels.id], visible: false };

  let land: LandPolygon[];
  let rivers: Position[][] = [];
  let towns: SubdivisionSeat[] = [];
  try {
    land = northOfTheBorder(coastlinePolygons(await loadBasemap('world-land-10m')));
    // Rivers are what a frontier settles on when it has the choice, so the
    // growth is given them; without them the borders ignore the one feature a
    // reader expects them to follow.
    rivers = riverLines(await loadBasemap('world-rivers-10m'));
    // Towns, which become the seats the members of each realm grow from. A
    // duchy named after a real town, centred on it, is what stops the internal
    // geography reading as an arbitrary partition of a shape.
    towns = townSeats(await loadBasemap('world-places-10m'));
  } catch {
    return { project, center: CENTER, zoom: ZOOM };
  }

  const seeds: RealmSeed[] = [];
  for (const empire of EMPIRES) {
    for (const realm of empire.realms) {
      seeds.push({
        id: realm.name,
        seeds: [realm.seat, ...(realm.also ?? [])],
        weight: realm.weight,
        ...(realm.bounds ? { bounds: realm.bounds } : {}),
      });
    }
  }
  const grown = growRealms(land, seeds, { extent: NORTH_AMERICA, ...DEFAULT_GROWTH }, rivers);

  /**
   * Every realm is its own sovereign.
   *
   * The map first gathered all twenty-eight groups into single territories, so
   * two continents read as twenty-eight blocs however many realms were inside
   * them; then it kept the seven the setting calls empires and dissolved the
   * rest. Now none of them survives as a bloc. A collapsed world is a world
   * with no one left to hold an empire together, and the map says so: each of
   * the realms stands alone, with its own colour and its own international
   * frontier, and what hierarchy remains is the one *inside* each of them —
   * the duchies, counties and baronies grown under every crown further down.
   */
  const sovereignStates: Territory[] = [];

  for (const empire of EMPIRES) {
    const parts: (Polygon | MultiPolygon)[] = [];
    for (const realm of empire.realms) {
      const shape = grown.shapes.get(realm.name);
      if (shape) parts.push(shape);
    }
    if (parts.length === 0) continue;

    {
      const seatRealm = empire.realms.find((r) => r.capital) ?? empire.realms[0];
      let seatStateId: string | null = null;
      for (const realm of empire.realms) {
        const shape = grown.shapes.get(realm.name);
        // A realm boxed in by its neighbours and trimmed away by the coast has
        // no ground, and a state with no ground is a name and a colour with
        // nothing under them — invisible on the plate until something tries to
        // edit it. The Oligarchy of Niagara was one, in every build until now.
        if (!shape || !(areaKm2(shape) > 0)) continue;
        const id = newId();
        if (realm === seatRealm) seatStateId = id;
        const state: Territory = {
          id,
          layerId: territoryLayer.id,
          name: realm.name,
          shortName: realm.short,
          politicalType: realm.type,
          relationship: 'sovereign',
          parentId: null,
          liegeId: null,
          capitalId: null,
          notes: '',
          locked: false,
          hidden: false,
          timeline: { start: null, end: null },
          geometry: shape,
          styleClassId: STYLE_IDS.territoryDefault,
          // Recoloured below, once every state exists and its neighbours are
          // known: tints of one group colour would only redraw the bloc.
          styleOverrides: { fillColor: empire.color },
          inheritParentColor: false,
          borderKind: 'international',
          labelId: null,
        };
        project.territories[id] = state;
        sovereignStates.push(state);
        attachLabel(project, id, 'territories', {
          layerId: countryLabels.id,
          kind: 'country',
          // The realm's whole title, not its short form: a state on this map
          // is the Factory of Detroit, and calling it Detroit throws away both
          // what it is and half of what makes the setting worth mapping. The
          // short form stays on the territory, for the places too tight for the
          // full one.
          coords: interiorPoint(shape),
          styleClassId: STYLE_IDS.textCountry,
          ...nameLayout(shape, realm.name, 0),
        });
      }
      if (seatStateId) {
        addCapital(project, seatRealm, seatStateId, settlementLayer.id, cityLabels.id);
      }
    }
  }

  /**
   * Break every realm into the states it was made of (spec §7).
   *
   * The realms produced above are scaffolding: each is grown from a seat, then
   * divided among its towns, and then *replaced* by those divisions. What
   * survives is the bottom level — the duchies, counties, cantons, baronies and
   * free cities — each of them sovereign. A realm too small to divide keeps its
   * own ground and stays a state itself, so no ground is lost.
   */
  let memberCount = 0;
  const successors: Territory[] = [];
  // Realms copied off a plate keep the names they were copied with.
  const whole = new Set(
    EMPIRES.flatMap((e) => e.realms.filter((r) => r.whole).map((r) => r.name)),
  );
  for (const parent of [...sovereignStates]) {
    if (!project.territories[parent.id]) continue;
    if (whole.has(parent.name)) {
      successors.push(parent);
      continue;
    }
    const made = addMembers(
      project,
      parent,
      towns,
      rivers,
      territoryLayer.id,
      countryLabels.id,
      successors,
      parent.styleOverrides.fillColor ?? '#d8d2c4',
    );
    memberCount += made;
    if (made === 0) successors.push(parent);
  }
  if (memberCount) console.debug(`After the End: ${successors.length} states`);

  // Colour the final states so no two neighbours share a tint — and it has to be
  // here, after every realm has been broken up, because the states being
  // coloured did not exist until then. The graph colourer is exactly the tool
  // for "many small states, each distinct from the ones it touches", and with
  // the realms gone that is the entire map.
  //
  // The After the End plates rather than the muted school-atlas inks: a quiet
  // palette was there to hold blocs together, and there are no blocs left.
  if (successors.length) {
    const colors = recolor(successors, (t) => t.styleOverrides.fillColor ?? '#d8d2c4', {
      mode: 'after-the-event',
    });
    for (const [id, color] of colors) {
      const t = project.territories[id];
      // A free city keeps its contrasting red; it is meant to stand out from
      // whatever surrounds it rather than to differ politely from it.
      if (t && t.styleOverrides.fillColor !== FREE_CITY_COLOR) {
        project.territories[id] = { ...t, styleOverrides: { ...t.styleOverrides, fillColor: color } };
      }
    }
  }

  for (const w of WATER_LABELS) {
    const label = makeLabel({
      layerId: waterLabels.id,
      kind: w.kind,
      text: w.text,
      coords: [w.lon, w.lat],
      styleClassId:
        w.kind === 'ocean'
          ? STYLE_IDS.textOcean
          : w.kind === 'mountain'
            ? STYLE_IDS.textRegion
            : STYLE_IDS.textWater,
      manualPosition: true,
    });
    project.labels[label.id] = label;
  }

  return { project, center: CENTER, zoom: ZOOM };
}

/**
 * How large to set a realm's name: as large as the realm, and as long as the
 * name.
 *
 * Every realm is named and none at the same size. That is how an atlas plate of
 * many small states is drawn — a grand duchy's title set across it in wide
 * capitals, a city-state's tucked inside at five points — and it is the only
 * way a hundred and thirty names sit on two continents without every one of
 * them fighting its neighbours for the same ground.
 *
 * Two measures, because a name has to fit in both directions. The realm's own
 * width, at the latitude it sits at, gives the room available — width rather
 * than area, since a long thin realm and a round one can share an area and not
 * a line to write on. Logarithmic, because the largest realm here is some four
 * hundred times the smallest. Then the length of the title itself: "Factory of
 * Detroit" needs two and a half times the room "Detroit" does, so it is set
 * proportionally smaller and comes out about as wide.
 */
/**
 * How a realm's name is set on it (spec §10, §42).
 *
 * The whole layout — angle, size, tracking, line breaks — is derived from the
 * territory's own shape and its depth in the hierarchy, so a name belongs to the
 * country rather than floating above its middle at whatever size the style class
 * happens to carry. See `render/labelFit.ts`.
 *
 * `PLATE_SCALE` is the pixels-per-degree the sizes are chosen for: the scale at
 * which you read realm names on this map. Labels are a fixed pixel size, so this
 * is a decision about which zoom the plate is composed for, not a conversion.
 */
const PLATE_SCALE = 26;

function nameLayout(
  shape: Polygon | MultiPolygon,
  text: string,
  depth: number,
): { rotation: number; text: string; style: Partial<TextStyle> } {
  const fit = fitLabel(text, shape, PLATE_SCALE, { depth });
  return {
    rotation: fit.rotation,
    text: fit.lines.join('\n'),
    style: { fontSize: fit.fontSize, tracking: fit.tracking },
  };
}

/**
 * The capital of a realm: a settlement, its symbol and its name.
 *
 * Shared because a sovereign state has one for exactly the same reason an
 * empire does, and the two used to differ only in which territory owned it.
 */
function addCapital(
  project: MapProject,
  seat: Realm,
  ownerId: string,
  settlementLayerId: string,
  cityLayerId: string,
  id: string = newId(),
): void {
  const settlement: Settlement = {
    id,
    layerId: settlementLayerId,
    name: seat.short,
    notes: '',
    locked: false,
    hidden: false,
    timeline: { start: null, end: null },
    type: 'national-capital',
    geometry: { type: 'Point', coordinates: seat.seat },
    population: null,
    ownerId,
    styleClassId: STYLE_IDS.symbolCapitalNational,
    styleOverrides: {},
    labelId: null,
  };
  project.settlements[id] = settlement;
  attachLabel(project, id, 'settlements', {
    layerId: cityLayerId,
    kind: 'city',
    text: settlement.name,
    coords: seat.seat,
    styleClassId: STYLE_IDS.textCapital,
    offset: [10, 0],
  });
}

/**
 * Break a realm up into the states it was made of (spec §7).
 *
 * The realm does not survive this. Its members are grown inside its outline and
 * then *replace* it: each becomes a sovereign in its own right, the realm's own
 * territory and name are deleted, and its capital is handed to whichever member
 * now holds the ground it stands on.
 *
 * The realms this runs over are the growth engine's output, so its shapes are
 * still what decides where the states are — a collapsed world's states are the
 * pieces the old realms fell into, not an unrelated partition of the continent.
 * What is gone is the crown above them.
 *
 * A realm too small to divide keeps its ground and stays a state itself, which
 * is why this returns 0 rather than deleting anything in that case: the
 * alternative is a hole in the map where a small realm used to be.
 */
function addMembers(
  project: MapProject,
  parent: Territory,
  towns: SubdivisionSeat[],
  rivers: Position[][],
  layerId: string,
  countryLabelLayerId: string,
  /** Every successor state is appended here, for the final recolouring. */
  out: Territory[],
  seedColor: string,
): number {
  const wanted = memberCountFor(areaKm2(parent.geometry));
  if (wanted < 2) return 0;

  // Bounds first, then the real test. Point-in-polygon against a traced realm of
  // a couple of thousand vertices, run over all seven thousand towns for each of
  // two hundred realms, was measured at 88 ms per realm; rejecting on the
  // bounding box first takes it to 1.
  const [bw, bs, be, bn] = bbox(parent.geometry);
  const inside = towns.filter(
    (t) =>
      t.point[0] >= bw &&
      t.point[0] <= be &&
      t.point[1] >= bs &&
      t.point[1] <= bn &&
      pointInside(t.point, parent.geometry),
  );
  const seats = pickSeats(inside, wanted, parent.geometry);
  if (seats.length < 2) return 0;

  const members = subdivideRealm(parent.geometry, seats, { rivers });
  if (members.length < 2) return 0;

  const created: Territory[] = [];
  for (const m of members) {
    // Same rule as the realms above: no ground, no state.
    if (!(areaKm2(m.geometry) > 0)) continue;
    const title = memberTitle(m.order, members.length, m.seat);
    const info = relationshipInfo(title.relationship);
    const id = newId();
    const state: Territory = {
      id,
      layerId,
      name: title.name,
      shortName: m.seat.name,
      politicalType: title.type,
      // Sovereign, not a member: there is no longer a realm above it to be a
      // member of. The title still says what kind of state it is — a duchy, a
      // county, a free city — because that is what it was when the world ended.
      relationship: 'sovereign',
      parentId: null,
      liegeId: null,
      capitalId: null,
      notes: '',
      locked: false,
      hidden: false,
      timeline: { start: null, end: null },
      geometry: m.geometry,
      styleClassId: STYLE_IDS.territoryDefault,
      // A free city keeps the contrasting red it is drawn with everywhere;
      // everything else is recoloured against its neighbours once the whole map
      // exists, which cannot be done until every realm has been broken up.
      styleOverrides: info.ownColor ? { fillColor: FREE_CITY_COLOR } : { fillColor: seedColor },
      inheritParentColor: false,
      borderKind: 'international',
      labelId: null,
    };
    project.territories[id] = state;
    created.push(state);
    attachLabel(project, id, 'territories', {
      layerId: countryLabelLayerId,
      kind: 'country',
      coords: interiorPoint(m.geometry),
      styleClassId: STYLE_IDS.textCountry,
      ...nameLayout(m.geometry, title.name, 0),
    });
  }

  // The realm itself goes, along with every name that pointed at it.
  //
  // By attachment rather than by `parent.labelId`: the territory handed in here
  // is the snapshot taken when it was created, and its label was attached to the
  // *stored* record a moment later — so the snapshot's `labelId` is still null
  // and reading it left the old realm's name printed across its successors.
  delete project.territories[parent.id];
  for (const label of Object.values(project.labels)) {
    if (label.attachedToId === parent.id) delete project.labels[label.id];
  }

  // Its capital is still a city; hand it to whichever successor holds the ground
  // it stands on, rather than leaving it pointing at a realm that no longer
  // exists.
  for (const settlement of Object.values(project.settlements)) {
    if (settlement.ownerId !== parent.id) continue;
    const [x, y] = settlement.geometry.coordinates as [number, number];
    const heir = created.find((c) => pointInside([x, y], c.geometry));
    project.settlements[settlement.id] = { ...settlement, ownerId: heir?.id ?? null };
  }

  out.push(...created);
  return members.length;
}

/** The contrasting red a free city is drawn in, as on the reference plate. */
const FREE_CITY_COLOR = '#c1272d';

/** Ray-casting point-in-polygon, holes included. */
function pointInside([x, y]: [number, number], g: Polygon | MultiPolygon): boolean {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    if (!ringHas(poly[0], x, y)) continue;
    let hole = false;
    for (let i = 1; i < poly.length; i++) if (ringHas(poly[i], x, y)) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

function ringHas(ring: Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Populated places as candidate seats for a realm's members. */
function townSeats(features: Awaited<ReturnType<typeof loadBasemap>>): SubdivisionSeat[] {
  const out: SubdivisionSeat[] = [];
  for (const f of pointsOf(features)) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const name = typeof props.name === 'string' ? props.name : '';
    if (!name) continue;
    const g = f.geometry;
    const c = g.type === 'Point' ? g.coordinates : g.coordinates[0];
    if (!c) continue;
    out.push({ name, point: [c[0], c[1]], rank: Number(props.scalerank ?? 10) });
  }
  return out;
}

/**
 * The titles a realm's members carry, largest first.
 *
 * A feudal map is not a grid of equal counties: it has one premier duchy, a
 * handful of counties under it, and cantons and baronies filling the gaps, and
 * the ladder is what makes the internal geography read as a hierarchy rather
 * than as an administrative partition. The last member of a large realm is its
 * free city where the town is important enough to have been one — a small
 * contrasting enclave inside its own realm.
 */
function memberTitle(order: number, count: number, seat: SubdivisionSeat): {
  name: string;
  type: PoliticalType;
  relationship: PoliticalRelationship;
} {
  if (order === 0) return { name: `Duchy of ${seat.name}`, type: 'duchy', relationship: 'constituent' };
  if (order === count - 1 && count >= 4 && seat.rank <= 6) {
    return { name: `Free City of ${seat.name}`, type: 'city-state', relationship: 'free-city' };
  }
  // One vassal per realm of any size: the point of the distinction is lost if
  // half the members carry it.
  if (order === 2 && count >= 4) {
    return { name: `County of ${seat.name}`, type: 'county', relationship: 'vassal' };
  }
  if (order === 1) return { name: `County of ${seat.name}`, type: 'county', relationship: 'constituent' };
  return order % 2
    ? { name: `Canton of ${seat.name}`, type: 'province', relationship: 'constituent' }
    : { name: `Barony of ${seat.name}`, type: 'barony', relationship: 'constituent' };
}

/** Every watercourse, as plain polylines. */
function riverLines(features: Awaited<ReturnType<typeof loadBasemap>>): Position[][] {
  const out: Position[][] = [];
  for (const f of linesOf(features)) {
    const g = f.geometry as LineString | MultiLineString;
    if (g.type === 'LineString') out.push(g.coordinates);
    else out.push(...g.coordinates);
  }
  return out;
}

/**
 * Every land polygon, each as its outer ring plus whatever it encloses.
 *
 * Kept as polygons rather than flattened to rings because the growth trims each
 * realm to the coastline, and that needs to know which ring is a hole in which.
 */
function coastlinePolygons(features: Awaited<ReturnType<typeof loadBasemap>>): LandPolygon[] {
  const out: LandPolygon[] = [];
  for (const f of polygonsOf(features)) {
    const g = f.geometry as Polygon | MultiPolygon;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    for (const poly of polys) out.push(poly);
  }
  return out;
}

/**
 * Cut the coastline down to the land the realms may grow on.
 *
 * Most of what goes is whole: South America, Cuba, Hispaniola and every other
 * island south of the line are separate polygons and fail on their extent
 * alone, which costs a comparison each. Only a shape that straddles the border
 * — the North American mainland, which carries Mexico and Central America with
 * it — is worth a boolean, and there are two or three of those.
 */
function northOfTheBorder(land: LandPolygon[]): LandPolygon[] {
  const [, south, , north] = ANGLO_AMERICA.coordinates[0].reduce(
    (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  // Above this every point of the mask's own edge is behind you, so a shape
  // that starts here is wholly inside it and needs no cutting.
  const clear = 30.1;

  const out: LandPolygon[] = [];
  for (const poly of land) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, y] of poly[0]) {
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    if (hi <= south || lo >= north) continue;
    if (lo >= clear) {
      out.push(poly);
      continue;
    }
    const kept = intersection({ type: 'Polygon', coordinates: poly }, ANGLO_AMERICA);
    if (kept) out.push(...landPolygonsOf([kept]));
  }
  return out;
}

function attachLabel(
  project: MapProject,
  ownerId: string,
  target: 'territories' | 'settlements',
  init: Parameters<typeof makeLabel>[0],
): void {
  const label = makeLabel({ ...init, attachedToId: ownerId });
  project.labels[label.id] = label;
  const collection = target === 'settlements' ? project.settlements : project.territories;
  const owner = collection[ownerId];
  if (owner) collection[ownerId] = { ...owner, labelId: label.id } as never;
}

function makeLabel(init: {
  layerId: string;
  kind: MapLabel['kind'];
  text: string;
  coords: [number, number] | number[];
  styleClassId: string;
  attachedToId?: string;
  offset?: [number, number];
  manualPosition?: boolean;
  hidden?: boolean;
  rotation?: number;
  fixedSize?: boolean;
  style?: Partial<TextStyle>;
}): MapLabel {
  return {
    id: newId(),
    layerId: init.layerId,
    name: init.text,
    notes: '',
    locked: false,
    hidden: init.hidden ?? false,
    timeline: { start: null, end: null },
    kind: init.kind,
    text: init.text,
    anchor: { type: 'Point', coordinates: [init.coords[0], init.coords[1]] },
    styleClassId: init.styleClassId,
    styleOverrides: init.style ?? {},
    attachedToId: init.attachedToId ?? null,
    pathId: null,
    manualPosition: init.manualPosition ?? false,
    offset: init.offset ?? [0, 0],
    rotation: init.rotation ?? 0,
    ignoreCollisions: false,
    fixedSize: init.fixedSize ?? defaultFixedSize(init.kind),
    curve: 0,
    maxWidth: null,
  };
}

/** Exposed for tests: the realm table, checkable without fetching anything. */
export const AFTER_THE_END_EMPIRES: readonly Empire[] = EMPIRES;

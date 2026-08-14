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

import { linesOf, loadBasemap, polygonsOf } from '@/geo/basemap';
import { dissolve, interiorPoint } from '@/geo/operations';
import { recolor } from '@/geo/palette';
import { DEFAULT_GROWTH, growRealms, type LandPolygon, type RealmSeed } from '@/geo/realmGrowth';
import { PALETTES, STYLE_IDS } from '@/model/defaults';
import { createProject, findLayerByKind } from '@/model/project';
import { newId } from '@/model/ids';
import type { MapLabel, MapProject, PoliticalType, Settlement, Territory, TextStyle } from '@/model/types';
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
const P = PALETTES.pastel;

const EMPIRES: Empire[] = [
  {
    name: 'Empire of Cascadia',
    short: 'CASCADIA',
    type: 'empire',
    color: M[1],
    label: [-131, 55],
    realms: [
      { name: 'Petty Kingdom of Olympus', short: 'Olympus', type: 'kingdom', seat: [-122.9, 47.0], weight: 0.9, capital: true },
      { name: 'Republic of Seattle', short: 'Seattle', type: 'republic', seat: [-122.33, 47.61], weight: 0.35 },
      { name: 'Duchy of Portlandia', short: 'Portlandia', type: 'duchy', seat: [-122.68, 45.52], weight: 0.5 },
      { name: 'Kingdom of Lincoln', short: 'Lincoln', type: 'kingdom', seat: [-123.09, 44.05], weight: 0.9 },
      { name: 'Petty Kingdom of the Okanagan', short: 'Okanagan', type: 'kingdom', seat: [-119.5, 49.9], weight: 0.9 },
      { name: 'Kingdom of Haida Tlagaang', short: 'Haida Tlagaang', type: 'kingdom', seat: [-130.3, 54.3], weight: 1.3 },
      { name: 'Duchy of Juneau', short: 'Juneau', type: 'duchy', seat: [-134.42, 58.30], weight: 1.0 },
      { name: 'Chiefdom of Aknuqtluk', short: 'Aknuqtluk', type: 'tribal-confederacy', seat: [-149.9, 61.2], weight: 1.4 },
      { name: 'High Chiefdom of Clearwater', short: 'Clearwater', type: 'tribal-confederacy', seat: [-116.0, 46.4], weight: 0.8 },
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
      { name: 'Duchy of Chisholm', short: 'Chisholm', type: 'duchy', seat: [-97.34, 37.69], weight: 1.1 },
      { name: 'Grand Division of Lead Belt', short: 'Lead Belt', type: 'province', seat: [-90.60, 37.30], weight: 0.6 },
    ],
  },
  {
    name: 'The Lone Star',
    short: 'LONE STAR',
    type: 'kingdom',
    color: A[6],
    label: [-101.5, 31.4],
    realms: [
      { name: 'Kingdom of Comancheria', short: 'Comancheria', type: 'kingdom', seat: [-101.86, 33.58], weight: 1.3, capital: true },
      { name: 'Duchy of Amarillo', short: 'Amarillo', type: 'duchy', seat: [-101.83, 35.22], weight: 0.9 },
      { name: 'Duchy of Metroplex', short: 'Metroplex', type: 'city-state', seat: [-97.05, 32.75], weight: 0.5 },
      { name: 'Longhorn Realm', short: 'Longhorn', type: 'duchy', seat: [-98.30, 30.30], weight: 0.8 },
      { name: 'Tribe of Airmen', short: 'Airmen', type: 'tribal-confederacy', seat: [-98.49, 29.42], weight: 0.6 },
      { name: 'Duchy of Aggies', short: 'Aggies', type: 'duchy', seat: [-96.33, 30.63], weight: 0.6 },
      { name: 'Duchy of Transpecos', short: 'Transpecos', type: 'duchy', seat: [-103.06, 30.90], weight: 1.0 },
      { name: 'Kingdom of Rio Grande', short: 'Rio Grande', type: 'kingdom', seat: [-99.51, 27.51], weight: 0.9 },
      { name: 'Duchy of Sequoyah', short: 'Sequoyah', type: 'duchy', seat: [-95.99, 36.15], weight: 0.9 },
    ],
  },
  {
    name: 'The Gulfcoast',
    short: 'GULFCOAST',
    type: 'confederation',
    color: A[8],
    label: [-92.6, 35.6],
    realms: [
      { name: 'Kingdom of Louisiane', short: 'Louisiane', type: 'kingdom', seat: [-91.19, 30.46], weight: 1.0, capital: true },
      { name: 'Republic of Orleans', short: 'Orleans', type: 'republic', seat: [-90.07, 29.95], weight: 0.4 },
      { name: 'Duchy of Ouachita', short: 'Ouachita', type: 'duchy', seat: [-93.75, 32.52], weight: 0.9 },
      { name: 'Duchy of Arkansas', short: 'Arkansas', type: 'duchy', seat: [-92.29, 34.75], weight: 1.0 },
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
      { name: 'Duchy of Yazoo', short: 'Yazoo', type: 'duchy', seat: [-90.18, 32.30], weight: 0.9 },
      { name: 'District of Natchez', short: 'Natchez', type: 'district', seat: [-86.80, 33.52], weight: 0.8 },
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
      { name: 'High Chiefdom of Nuevo México', short: 'Nuevo México', type: 'tribal-confederacy', seat: [-105.94, 35.69], weight: 1.0 },
      { name: 'Duchy of Sonora', short: 'Sonora', type: 'duchy', seat: [-110.97, 29.07], weight: 1.1 },
      { name: 'Kingdom of Rio Bravo', short: 'Rio Bravo', type: 'kingdom', seat: [-106.09, 28.63], weight: 1.2 },
      { name: 'Duchy of Coahuila', short: 'Coahuila', type: 'duchy', seat: [-101.00, 26.90], weight: 1.0 },
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
      { name: 'Kingdom of Péten', short: 'Péten', type: 'kingdom', seat: [-89.89, 16.92], weight: 0.7 },
    ],
  },
  {
    name: 'Centroamérica',
    short: 'CENTROAMÉRICA',
    type: 'confederation',
    color: M[6],
    label: [-85.0, 11.6],
    realms: [
      { name: 'Duchy of Guatemala', short: 'Guatemala', type: 'duchy', seat: [-90.51, 14.63], weight: 0.7, capital: true },
      { name: 'Ajawil of Verapazes', short: 'Verapazes', type: 'principality', seat: [-90.37, 15.47], weight: 0.4 },
      { name: 'Duchy of Salvador', short: 'Salvador', type: 'duchy', seat: [-89.19, 13.69], weight: 0.5 },
      { name: 'Marquisate of Atlántida', short: 'Atlántida', type: 'march', seat: [-87.99, 15.50], weight: 0.6 },
      { name: 'County of Comayagua', short: 'Comayagua', type: 'county', seat: [-87.21, 14.08], weight: 0.4 },
      { name: 'Kingdom of Moskitia', short: 'Moskitia', type: 'kingdom', seat: [-83.77, 12.01], weight: 0.7 },
      { name: 'Duchy of Nicaragua', short: 'Nicaragua', type: 'duchy', seat: [-86.25, 12.14], weight: 0.6 },
      { name: 'Duchy of Las Brumas', short: 'Las Brumas', type: 'duchy', seat: [-84.09, 9.93], weight: 0.6 },
      { name: 'Captaincy of San Andrés', short: 'San Andrés', type: 'march', seat: [-79.55, 9.00], weight: 0.6 },
    ],
  },
  {
    name: 'Caribbean Empire',
    short: 'CARIBBEAN',
    type: 'empire',
    color: M[7],
    label: [-74.0, 23.4],
    realms: [
      { name: 'Kingdom of Cuba', short: 'Cuba', type: 'kingdom', seat: [-82.37, 23.11], weight: 0.9, capital: true },
      { name: 'Captaincy of Tortuga', short: 'Tortuga', type: 'march', seat: [-72.33, 18.54], weight: 0.5 },
      { name: 'Kingdom of Santo Domingo', short: 'Santo Domingo', type: 'kingdom', seat: [-69.93, 18.49], weight: 0.5 },
      { name: 'Kingdom of Jamaica', short: 'Jamaica', type: 'kingdom', seat: [-76.79, 17.99], weight: 0.4 },
      { name: 'Flotilla of the Leeward Isles', short: 'Leeward Isles', type: 'march', seat: [-77.35, 25.06], weight: 0.5 },
      { name: 'Kingdom of Gran Trinidad', short: 'Gran Trinidad', type: 'kingdom', seat: [-61.51, 10.65], weight: 0.5 },
    ],
  },
  {
    name: 'Gran Colombia',
    short: 'GRAN COLOMBIA',
    type: 'confederation',
    color: P[0],
    label: [-73.5, 5.4],
    realms: [
      { name: 'High Chiefdom of Cundinamarca', short: 'Cundinamarca', type: 'tribal-confederacy', seat: [-74.07, 4.71], weight: 0.9, capital: true },
      { name: 'High Chiefdom of Vallecafé', short: 'Vallecafé', type: 'tribal-confederacy', seat: [-75.57, 6.24], weight: 0.8 },
      { name: 'High Chiefdom of Cauca', short: 'Cauca', type: 'tribal-confederacy', seat: [-76.53, 3.44], weight: 0.8 },
      { name: 'Republic of Cartagena', short: 'Cartagena', type: 'republic', seat: [-75.51, 10.39], weight: 0.7 },
      { name: 'Kingdom of Zulia', short: 'Zulia', type: 'kingdom', seat: [-71.61, 10.65], weight: 0.8 },
      { name: 'Kingdom of Venezuela', short: 'Venezuela', type: 'kingdom', seat: [-66.90, 10.49], weight: 1.1 },
      { name: 'Kingdom of Puente Grande', short: 'Puente Grande', type: 'kingdom', seat: [-70.20, 8.60], weight: 0.7 },
    ],
  },
  {
    name: 'The Guyanas',
    short: 'GUYANAS',
    type: 'confederation',
    color: P[3],
    label: [-58.5, 4.0],
    realms: [
      { name: 'Kingdom of Guyana', short: 'Guyana', type: 'kingdom', seat: [-58.16, 6.80], weight: 0.9, capital: true },
      { name: 'Kingdom of Bolívar', short: 'Bolívar', type: 'kingdom', seat: [-63.55, 8.12], weight: 1.1 },
      { name: 'High Chiefdom of Gran Sabana', short: 'Gran Sabana', type: 'tribal-confederacy', seat: [-61.40, 5.60], weight: 0.8 },
      { name: 'High Chiefdom of Roraima', short: 'Roraima', type: 'tribal-confederacy', seat: [-60.67, 2.82], weight: 0.9 },
    ],
  },
  {
    name: 'Amazonia',
    short: 'AMAZONIA',
    type: 'confederation',
    color: P[2],
    label: [-64.0, -5.0],
    realms: [
      { name: 'Chiefdom of Manaus', short: 'Manaus', type: 'tribal-confederacy', seat: [-60.02, -3.10], weight: 1.6, capital: true },
      { name: 'Chiefdom of Solimões', short: 'Solimões', type: 'tribal-confederacy', seat: [-69.94, -4.22], weight: 1.4 },
      { name: 'Chiefdom of Belém', short: 'Belém', type: 'tribal-confederacy', seat: [-48.50, -1.46], weight: 1.3 },
      { name: 'Chiefdom of Rondônia', short: 'Rondônia', type: 'tribal-confederacy', seat: [-63.90, -8.76], weight: 1.2 },
    ],
  },
  {
    name: 'Empire of Brasil',
    short: 'BRASIL',
    type: 'empire',
    color: P[4],
    label: [-43.0, -20.5],
    realms: [
      { name: 'Kingdom of Rio', short: 'Rio', type: 'kingdom', seat: [-43.20, -22.91], weight: 0.8, capital: true },
      { name: 'Kingdom of São Paulo', short: 'São Paulo', type: 'kingdom', seat: [-46.63, -23.55], weight: 0.9 },
      { name: 'Kingdom of Bahia', short: 'Bahia', type: 'kingdom', seat: [-38.51, -12.97], weight: 1.1 },
      { name: 'Duchy of Pernambuco', short: 'Pernambuco', type: 'duchy', seat: [-34.88, -8.05], weight: 0.9 },
      { name: 'Duchy of Minas', short: 'Minas', type: 'duchy', seat: [-43.94, -19.92], weight: 0.9 },
    ],
  },
  {
    name: 'The Cerrado',
    short: 'CERRADO',
    type: 'confederation',
    color: P[6],
    label: [-51.0, -12.0],
    realms: [
      { name: 'Chiefdom of Goiás', short: 'Goiás', type: 'tribal-confederacy', seat: [-49.25, -16.68], weight: 1.2, capital: true },
      { name: 'Chiefdom of Mato Grosso', short: 'Mato Grosso', type: 'tribal-confederacy', seat: [-56.10, -15.60], weight: 1.3 },
      { name: 'Chiefdom of Tocantins', short: 'Tocantins', type: 'tribal-confederacy', seat: [-48.33, -10.18], weight: 1.1 },
      { name: 'Chiefdom of Piauí', short: 'Piauí', type: 'tribal-confederacy', seat: [-42.80, -5.09], weight: 1.1 },
    ],
  },
  {
    name: 'Perulivia',
    short: 'PERULIVIA',
    type: 'confederation',
    color: P[8],
    label: [-72.5, -13.0],
    realms: [
      { name: 'Kingdom of Lima', short: 'Lima', type: 'kingdom', seat: [-77.03, -12.05], weight: 0.9, capital: true },
      { name: 'High Chiefdom of Cusco', short: 'Cusco', type: 'tribal-confederacy', seat: [-71.97, -13.53], weight: 1.0 },
      { name: 'High Chiefdom of Titicaca', short: 'Titicaca', type: 'tribal-confederacy', seat: [-68.15, -16.50], weight: 1.0 },
      { name: 'Kingdom of Quito', short: 'Quito', type: 'kingdom', seat: [-78.47, -0.18], weight: 0.9 },
      { name: 'Duchy of Guayaquil', short: 'Guayaquil', type: 'duchy', seat: [-79.90, -2.17], weight: 0.6 },
      { name: 'Chiefdom of Sucre', short: 'Sucre', type: 'tribal-confederacy', seat: [-65.26, -19.03], weight: 0.9 },
    ],
  },
  {
    name: 'Kingdom of Chile',
    short: 'CHILE',
    type: 'kingdom',
    color: P[10],
    label: [-71.6, -29.0],
    realms: [
      { name: 'Kingdom of Santiago', short: 'Santiago', type: 'kingdom', seat: [-70.65, -33.46], weight: 0.7, capital: true },
      { name: 'Duchy of Atacama', short: 'Atacama', type: 'duchy', seat: [-70.40, -23.65], weight: 1.0 },
      { name: 'Duchy of Valdivia', short: 'Valdivia', type: 'duchy', seat: [-73.25, -39.81], weight: 0.7 },
    ],
  },
  {
    name: 'La Plata',
    short: 'LA PLATA',
    type: 'confederation',
    color: P[1],
    label: [-63.5, -32.5],
    realms: [
      { name: 'Republic of Buenos Aires', short: 'Buenos Aires', type: 'republic', seat: [-58.38, -34.60], weight: 1.0, capital: true },
      { name: 'Duchy of Córdoba', short: 'Córdoba', type: 'duchy', seat: [-64.18, -31.42], weight: 1.0 },
      { name: 'Duchy of Cuyo', short: 'Cuyo', type: 'duchy', seat: [-68.84, -32.89], weight: 0.9 },
      { name: 'Kingdom of the Banda Oriental', short: 'Banda Oriental', type: 'kingdom', seat: [-56.16, -34.90], weight: 0.7 },
      { name: 'Duchy of Litoral', short: 'Litoral', type: 'duchy', seat: [-60.70, -32.95], weight: 0.7 },
    ],
  },
  {
    name: 'Gran Chaco',
    short: 'GRAN CHACO',
    type: 'confederation',
    color: P[5],
    label: [-59.5, -22.5],
    realms: [
      { name: 'Chiefdom of Asunción', short: 'Asunción', type: 'tribal-confederacy', seat: [-57.58, -25.28], weight: 1.0, capital: true },
      { name: 'Chiefdom of Chaco Boreal', short: 'Chaco Boreal', type: 'tribal-confederacy', seat: [-60.50, -22.00], weight: 1.1 },
      { name: 'Chiefdom of Tucumán', short: 'Tucumán', type: 'tribal-confederacy', seat: [-65.22, -26.82], weight: 0.9 },
    ],
  },
  {
    name: 'Patagonia',
    short: 'PATAGONIA',
    type: 'confederation',
    color: P[7],
    label: [-68.0, -46.0],
    realms: [
      { name: 'Chiefdom of Nahuel Huapi', short: 'Nahuel Huapi', type: 'tribal-confederacy', seat: [-71.31, -41.13], weight: 1.1, capital: true },
      { name: 'Chiefdom of Chubut', short: 'Chubut', type: 'tribal-confederacy', seat: [-65.10, -43.30], weight: 1.1 },
      { name: 'Chiefdom of Magallanes', short: 'Magallanes', type: 'tribal-confederacy', seat: [-70.92, -53.16], weight: 1.0 },
    ],
  },
];

/** Seas and gulfs, so the water is not anonymous (§12). */
const WATER_LABELS: { text: string; lon: number; lat: number; kind: MapLabel['kind'] }[] = [
  { text: 'Atlantic Ocean', lon: -40, lat: 22, kind: 'ocean' },
  { text: 'Pacific Ocean', lon: -132, lat: 5, kind: 'ocean' },
  { text: 'Gulf of Mexico', lon: -90.5, lat: 25.2, kind: 'water' },
  { text: 'Caribbean Sea', lon: -75.5, lat: 14.5, kind: 'water' },
  { text: 'Hudson Bay', lon: -85.5, lat: 59.5, kind: 'water' },
  { text: 'Gulf of Alaska', lon: -146, lat: 56.5, kind: 'water' },
  { text: 'Labrador Sea', lon: -55.5, lat: 59.5, kind: 'water' },
  { text: 'Gulf of California', lon: -111.5, lat: 27.5, kind: 'water' },
  { text: 'Drake Passage', lon: -66, lat: -58.5, kind: 'water' },
];

export interface AfterTheEndResult {
  project: MapProject;
  center: [number, number];
  zoom: number;
}

const CENTER: [number, number] = [-80, 10];
const ZOOM = 2.5;
/** The New World, with sea room. Nothing outside it is loaded or drawable. */
const AMERICAS: [number, number, number, number] = [-172, -58, -30, 76];

/**
 * Build the map. Async because it fetches the real coastline to grow on;
 * returns an empty project if that fetch fails, rather than a half-built one.
 */
export async function buildAfterTheEndProject(): Promise<AfterTheEndResult> {
  const project = createProject({
    title: 'After the End',
    projectionId: 'ATF:AMERICAS',
    center: CENTER,
    zoom: ZOOM,
    workingExtent: AMERICAS,
  });
  project.meta.subtitle = 'The realms of the New World';
  project.meta.dateLine = 'In the Year 2666';
  project.meta.author = 'After the Fall — a map of the After the End setting';
  project.meta.notes =
    'Realm names, their tier and the empire each belongs to follow the After the End realm list. ' +
    'The shapes are grown outward from each realm\'s seat of power rather than traced from modern ' +
    'administrative boundaries, and the land nobody claimed is left as wilderness. Every border ' +
    'is an ordinary editable territory.';
  project.oceanColor = '#c6dae6';
  project.landColor = '#eae3d3';
  // The Americas at Natural Earth's finest published scale — coastline, inland
  // water, rivers and cities — all cropped to the working extent above.
  project.basemap = [
    { sourceId: 'world-land-10m', visible: true, opacity: 1 },
    { sourceId: 'world-lakes-10m', visible: true, opacity: 1 },
    { sourceId: 'world-rivers-10m', visible: true, opacity: 1 },
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
  const regionLabels = Object.values(project.layers).find((l) => l.name === 'Region Labels')!;
  const cityLabels = Object.values(project.layers).find((l) => l.name === 'City Labels')!;
  const waterLabels = Object.values(project.layers).find((l) => l.name === 'Water Labels')!;

  // Vassal and capital names start off. A hundred and fifty realm names and
  // thirty capitals under thirty empire names is a mat rather than a map, and
  // §11 never drops a label on its own. The map opens the way an atlas index
  // plate does — sovereign names only, every realm drawn and coloured — and
  // either layer is one click away.
  project.layers[regionLabels.id] = { ...project.layers[regionLabels.id], visible: false };
  project.layers[cityLabels.id] = { ...project.layers[cityLabels.id], visible: false };

  let land: LandPolygon[];
  let rivers: Position[][] = [];
  try {
    land = coastlinePolygons(await loadBasemap('world-land-10m'));
    // Rivers are what a frontier settles on when it has the choice, so the
    // growth is given them; without them the borders ignore the one feature a
    // reader expects them to follow.
    rivers = riverLines(await loadBasemap('world-rivers-10m'));
  } catch {
    return { project, center: CENTER, zoom: ZOOM };
  }

  const seeds: RealmSeed[] = [];
  for (const empire of EMPIRES) {
    for (const realm of empire.realms) {
      seeds.push({ id: realm.name, seeds: [realm.seat, ...(realm.also ?? [])], weight: realm.weight });
    }
  }
  const grown = growRealms(land, seeds, { extent: AMERICAS, ...DEFAULT_GROWTH }, rivers);

  /**
   * Only a real empire is drawn as one.
   *
   * The map used to gather all twenty-eight groups into single territories, so
   * two continents read as twenty-eight blocs however many realms were inside
   * them — which is not what a collapsed world looks like. A confederation is
   * an alliance of states, not a state; a group of petty kingdoms is a region,
   * not a realm. Those now dissolve into their members, each of which is its
   * own sovereign with its own colour and its own international border, and
   * only the seven groups the setting actually calls empires still gather
   * their realms under one crown. 28 blocs become 7 empires and 130 states.
   */
  const sovereignStates: Territory[] = [];

  for (const empire of EMPIRES) {
    const parts: (Polygon | MultiPolygon)[] = [];
    for (const realm of empire.realms) {
      const shape = grown.shapes.get(realm.name);
      if (shape) parts.push(shape);
    }
    if (parts.length === 0) continue;

    if (empire.type !== 'empire') {
      const seatRealm = empire.realms.find((r) => r.capital) ?? empire.realms[0];
      let seatStateId: string | null = null;
      for (const realm of empire.realms) {
        const shape = grown.shapes.get(realm.name);
        if (!shape) continue;
        const id = newId();
        if (realm === seatRealm) seatStateId = id;
        const state: Territory = {
          id,
          layerId: territoryLayer.id,
          name: realm.name,
          shortName: realm.short,
          politicalType: realm.type,
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
          text: realm.short,
          coords: interiorPoint(shape),
          styleClassId: STYLE_IDS.textCountry,
          // Sized below, once the shape is known: a name belongs to its state
          // and should look like it does.
          style: stateNameStyle(shape),
        });
      }
      if (seatStateId) {
        addCapital(project, seatRealm, seatStateId, settlementLayer.id, cityLabels.id);
      }
      continue;
    }
    const whole = parts.length === 1 ? parts[0] : dissolve(parts);
    if (!whole) continue;

    const empireId = newId();
    const seat = empire.realms.find((r) => r.capital) ?? empire.realms[0];
    const capitalId = newId();

    project.territories[empireId] = {
      id: empireId,
      layerId: territoryLayer.id,
      name: empire.name,
      shortName: empire.short,
      politicalType: empire.type,
      parentId: null,
      liegeId: null,
      capitalId,
      notes: '',
      locked: false,
      hidden: false,
      timeline: { start: null, end: null },
      geometry: whole,
      styleClassId: STYLE_IDS.territoryDefault,
      styleOverrides: { fillColor: empire.color },
      inheritParentColor: false,
      borderKind: 'international',
      labelId: null,
    };
    attachLabel(project, empireId, 'territories', {
      layerId: countryLabels.id,
      kind: 'country',
      text: empire.short,
      coords: empire.label ?? interiorPoint(whole),
      styleClassId: STYLE_IDS.textCountry,
      manualPosition: !!empire.label,
      // Smaller and tighter than the default country style: that default is set
      // for a plate showing one realm, and here thirty share two continents.
      style: { fontSize: 10.5, tracking: 2 },
    });

    empire.realms.forEach((realm, index) => {
      const shape = grown.shapes.get(realm.name);
      if (!shape) return;
      const realmId = newId();
      project.territories[realmId] = {
        ...project.territories[empireId],
        id: realmId,
        name: realm.name,
        shortName: realm.short,
        politicalType: realm.type,
        parentId: empireId,
        liegeId: empireId,
        capitalId: null,
        geometry: shape,
        styleOverrides: { fillColor: vassalColor(empire.color, index, empire.realms.length) },
        inheritParentColor: false,
        borderKind: 'subordinate',
        labelId: null,
      };
      attachLabel(project, realmId, 'territories', {
        layerId: regionLabels.id,
        kind: 'region',
        text: realm.short,
        coords: interiorPoint(shape),
        styleClassId: STYLE_IDS.textRegion,
      });
    });

    addCapital(project, seat, empireId, settlementLayer.id, cityLabels.id, capitalId);
  }

  // Colour the sovereign states so no two neighbours share a tint. They came
  // out of the same group and carried its colour, which would have drawn the
  // bloc all over again in a different way — the graph colourer is exactly the
  // tool for "many small states, each distinct from the ones it touches".
  if (sovereignStates.length) {
    const colors = recolor(sovereignStates, (t) => t.styleOverrides.fillColor ?? '#d8d2c4', {
      mode: 'historical-atlas',
    });
    for (const [id, color] of colors) {
      const t = project.territories[id];
      if (t) project.territories[id] = { ...t, styleOverrides: { ...t.styleOverrides, fillColor: color } };
    }
  }

  for (const w of WATER_LABELS) {
    const label = makeLabel({
      layerId: waterLabels.id,
      kind: w.kind,
      text: w.text,
      coords: [w.lon, w.lat],
      styleClassId: w.kind === 'ocean' ? STYLE_IDS.textOcean : STYLE_IDS.textWater,
      manualPosition: true,
    });
    project.labels[label.id] = label;
  }

  return { project, center: CENTER, zoom: ZOOM };
}

/**
 * How large to set a state's name: as large as the state.
 *
 * Every state is named, and none of them is named at the same size. That is how
 * an atlas plate of many small realms is drawn — a grand duchy's name is set
 * across it in wide capitals, a city-state's is four points and tucked inside —
 * and it is the only way a hundred and thirty names sit on two continents
 * without every one of them fighting its neighbours for the same ground.
 *
 * The measure is the realm's own width, at the latitude it sits at, so a name
 * is scaled by the room it actually has rather than by an area that a long thin
 * realm and a round one can share. Logarithmic, because the largest realm here
 * is some four hundred times the smallest and a linear scale would set one of
 * them at a hundred points or the other at a quarter of one.
 */
function stateNameStyle(shape: Polygon | MultiPolygon): { fontSize: number; tracking: number } {
  const rings = shape.type === 'Polygon' ? shape.coordinates : shape.coordinates.flat();
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
    }
  }
  if (!Number.isFinite(west)) return { fontSize: 6, tracking: 0.8 };
  const km = Math.max(
    (east - west) * 111 * Math.max(0.2, Math.cos((((south + north) / 2) * Math.PI) / 180)),
    (north - south) * 111,
  );

  // 300 km sets the floor, 2,600 km the ceiling: the span between a petty realm
  // and an empire on this map.
  const t = Math.min(1, Math.max(0, Math.log(km / 300) / Math.log(2600 / 300)));
  const fontSize = Number((5 + t * 6.5).toFixed(2));
  return { fontSize, tracking: Number((fontSize * 0.17).toFixed(2)) };
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
 * A realm's own colour: its liege's, shifted.
 *
 * Vassals could simply inherit, and §7 supports that — but then an empire is one
 * flat wash and its vassals are only visible as hairlines, which is not how a
 * political map of many small realms reads. Varying lightness and saturation
 * around the liege's colour keeps the family legible while giving each realm its
 * own tint, exactly as a hand-coloured atlas plate does.
 */
function vassalColor(base: string, index: number, count: number): string {
  const hex = base.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  // Spread the vassals over a band around the liege rather than in one
  // direction, so no empire ends up uniformly darker than its neighbours.
  const t = count <= 1 ? 0 : index / (count - 1) - 0.5;
  const hue = (h + t * 26 + 360) % 360;
  const sat = Math.max(0.06, Math.min(0.62, s + t * 0.16));
  const lum = Math.max(0.52, Math.min(0.87, l - t * 0.17));

  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lum - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const rgb = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg];
  const to255 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to255(rgb[0])}${to255(rgb[1])}${to255(rgb[2])}`;
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
    rotation: 0,
    ignoreCollisions: false,
    maxWidth: null,
  };
}

/** Exposed for tests: the realm table, checkable without fetching anything. */
export const AFTER_THE_END_EMPIRES: readonly Empire[] = EMPIRES;

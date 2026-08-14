/**
 * A political map of the post-apocalyptic Americas, after the *After the End*
 * setting for Crusader Kings (spec §65 — a worked example, not a special case).
 *
 * Every realm here is built by the same public API the UI uses: real Natural
 * Earth admin-1 subdivisions are dissolved into territories, arranged into the
 * empire → kingdom hierarchy of §7, given the border tiers of §8, and labelled
 * by the same label engine as anything you draw yourself. Nothing in the
 * application knows this file exists.
 *
 * On accuracy. The realm names and the empire each belongs to are taken from the
 * mod's own realm list. The *shapes* are not: the mod has a hand-drawn province
 * map that is not published as geodata, so each realm is approximated here by
 * the modern states, provinces and departments it most nearly covers. Read it as
 * a plausible atlas of that world rather than a tracing of the mod's map — and
 * every border is editable, which is the point of the application.
 */

import { basemapFeatureName, loadBasemap, polygonsOf } from '@/geo/basemap';
import { dissolve, interiorPoint } from '@/geo/operations';
import { PALETTES, STYLE_IDS } from '@/model/defaults';
import { createProject, findLayerByKind } from '@/model/project';
import { newId } from '@/model/ids';
import type { MapLabel, MapProject, PoliticalType, Settlement, TextStyle } from '@/model/types';
import type { MultiPolygon, Polygon } from 'geojson';

/**
 * A realm. `units` are admin-1 subdivisions written `ISO3:Name`, qualified by
 * country because the names collide freely — Colón is in both Honduras and
 * Panama, Durango is a Mexican state and a Colorado town, and there is a
 * Portland in Jamaica.
 */
interface RealmDef {
  name: string;
  /** Name without its title, for the compact label. */
  short: string;
  type: PoliticalType;
  units: string[];
  /** Vassal realms. Their units count towards this realm's extent too. */
  realms?: RealmDef[];
  capital?: { name: string; lon: number; lat: number };
  color?: string;
  /**
   * Where to set the realm's name, when the centre of its area is the wrong
   * place for it. An atlas places these by hand for exactly this reason: the
   * centroid of the Great Lakes realms is a lake, and three neighbouring names
   * set in wide-tracked capitals will collide however good the automatic
   * placement is. §11 never drops a label, so the answer is to put it somewhere
   * it fits rather than hope.
   */
  label?: { lon: number; lat: number };
}

const ATLAS = PALETTES['historical-atlas'];
const MUTED = PALETTES.muted;

/** Every US state and DC, as `USA:` units — the base of several large realms. */
const usa = (...names: string[]) => names.map((n) => `USA:${n}`);
const can = (...names: string[]) => names.map((n) => `CAN:${n}`);
const mex = (...names: string[]) => names.map((n) => `MEX:${n}`);

const EMPIRES: RealmDef[] = [
  {
    name: 'The Arctic',
    label: { lon: -96, lat: 66.5 },
    short: 'ARCTIC',
    type: 'confederation',
    units: [],
    color: ATLAS[9],
    capital: { name: 'Iqaluit', lon: -68.517, lat: 63.746 },
    realms: [
      {
        name: 'Kingdom of Nunavik',
        short: 'Nunavik',
        type: 'kingdom',
        units: can('Nunavut', 'Northwest Territories'),
      },
      {
        name: 'Petty Kingdom of Avalon',
        short: 'Avalon',
        type: 'kingdom',
        units: can('Newfoundland and Labrador'),
      },
      // Greenland is deliberately left unclaimed: the setting is the Americas,
      // and inventing a realm for it would be putting words in the mod's mouth.
    ],
  },
  {
    name: 'Empire of Canada',
    label: { lon: -79.0, lat: 51.5 },
    short: 'CANADA',
    type: 'empire',
    units: [],
    color: ATLAS[0],
    capital: { name: 'Montréal', lon: -73.568, lat: 45.502 },
    realms: [
      { name: 'Kingdom of Ontario', short: 'Ontario', type: 'kingdom', units: can('Ontario') },
      { name: 'Ursuline See', short: 'Ursuline See', type: 'theocracy', units: can('Québec') },
      {
        name: 'Kingdom of the Maritimes',
        short: 'Maritimes',
        type: 'kingdom',
        units: can('New Brunswick', 'Nova Scotia', 'Prince Edward Island'),
      },
    ],
  },
  {
    name: 'Empire of Atlantica',
    label: { lon: -71.0, lat: 44.6 },
    short: 'ATLANTICA',
    type: 'empire',
    units: [],
    color: ATLAS[3],
    capital: { name: 'New York', lon: -74.006, lat: 40.713 },
    realms: [
      { name: 'Kingdom of Hudsonia', short: 'Hudsonia', type: 'kingdom', units: usa('New York') },
      { name: 'Kingdom of Deitschrei', short: 'Deitschrei', type: 'kingdom', units: usa('Pennsylvania') },
      { name: 'District of South Jersey', short: 'South Jersey', type: 'district', units: usa('New Jersey') },
      {
        name: 'District of Delmarva',
        short: 'Delmarva',
        type: 'district',
        units: usa('Delaware', 'Maryland'),
      },
      {
        name: 'District Court of Columbia',
        short: 'Columbia',
        type: 'district',
        units: usa('District of Columbia'),
      },
      {
        name: 'District of Connecticut',
        short: 'Connecticut',
        type: 'district',
        units: usa('Connecticut', 'Rhode Island'),
      },
      { name: 'Chiefdom of Plymouth', short: 'Plymouth', type: 'tribal-confederacy', units: usa('Massachusetts') },
      {
        name: 'Duchy of the Green Mountains',
        short: 'Green Mountains',
        type: 'duchy',
        units: usa('Vermont', 'New Hampshire'),
      },
      { name: 'High Chiefdom of Penobscot', short: 'Penobscot', type: 'tribal-confederacy', units: usa('Maine') },
    ],
  },
  {
    name: 'Grand Virginia',
    label: { lon: -81.5, lat: 35.4 },
    short: 'GRAND VIRGINIA',
    type: 'confederation',
    units: [],
    color: ATLAS[4],
    capital: { name: 'Richmond', lon: -77.436, lat: 37.541 },
    realms: [
      { name: 'Republic of Chesapeake', short: 'Chesapeake', type: 'republic', units: usa('Virginia') },
      { name: 'High Chiefdom of Vandalia', short: 'Vandalia', type: 'tribal-confederacy', units: usa('West Virginia') },
      { name: 'Grand Division of Bluegrass', short: 'Bluegrass', type: 'province', units: usa('Kentucky') },
      { name: 'Grand Division of East Tennessee', short: 'East Tennessee', type: 'province', units: usa('Tennessee') },
      { name: 'High Chiefdom of Blue Ridge', short: 'Blue Ridge', type: 'tribal-confederacy', units: usa('North Carolina') },
    ],
  },
  {
    name: 'Holy Columbian Confederacy',
    label: { lon: -83.0, lat: 31.2 },
    short: 'HOLY COLUMBIA',
    type: 'confederation',
    units: usa('South Carolina'),
    color: ATLAS[2],
    capital: { name: 'Atlanta', lon: -84.388, lat: 33.749 },
    realms: [
      { name: 'Metropolis of Choctaw', short: 'Choctaw', type: 'city-state', units: usa('Georgia') },
      { name: 'District of Natchez', short: 'Natchez', type: 'district', units: usa('Alabama') },
      { name: 'Duchy of Yazoo', short: 'Yazoo', type: 'duchy', units: usa('Florida') },
    ],
  },
  {
    name: 'The Gulfcoast',
    label: { lon: -93.6, lat: 34.9 },
    short: 'GULFCOAST',
    type: 'confederation',
    units: [],
    color: ATLAS[8],
    capital: { name: 'New Orleans', lon: -90.071, lat: 29.951 },
    realms: [
      { name: 'Kingdom of Louisiane', short: 'Louisiane', type: 'kingdom', units: usa('Louisiana') },
      { name: 'Duchy of Ouachita', short: 'Ouachita', type: 'duchy', units: usa('Arkansas') },
      { name: 'Duchy of Mobile', short: 'Mobile', type: 'duchy', units: usa('Mississippi') },
    ],
  },
  {
    name: 'The Lone Star',
    label: { lon: -100.0, lat: 32.6 },
    short: 'LONE STAR',
    type: 'kingdom',
    units: [],
    color: ATLAS[6],
    capital: { name: 'San Antonio', lon: -98.494, lat: 29.424 },
    realms: [
      { name: 'Kingdom of Rio Grande', short: 'Rio Grande', type: 'kingdom', units: usa('Texas') },
      { name: 'Kingdom of Comancheria', short: 'Comancheria', type: 'kingdom', units: usa('Oklahoma') },
    ],
  },
  {
    name: 'The Heartland',
    label: { lon: -98.6, lat: 40.2 },
    short: 'HEARTLAND',
    type: 'confederation',
    units: usa('Kansas'),
    color: ATLAS[1],
    capital: { name: 'St. Louis', lon: -90.199, lat: 38.627 },
    realms: [
      { name: 'Kingdom of Iowa', short: 'Iowa', type: 'kingdom', units: usa('Iowa') },
      { name: 'Kingdom of Platte', short: 'Platte', type: 'kingdom', units: usa('Nebraska') },
      { name: 'Republic of Boonslick', short: 'Boonslick', type: 'republic', units: usa('Missouri') },
    ],
  },
  {
    name: 'The Great Lakes',
    label: { lon: -87.8, lat: 46.2 },
    short: 'GREAT LAKES',
    type: 'confederation',
    units: usa('Indiana', 'Ohio'),
    color: ATLAS[5],
    capital: { name: 'Chicago', lon: -87.632, lat: 41.884 },
    realms: [
      { name: 'Petty Kingdom of Illinois', short: 'Illinois', type: 'kingdom', units: usa('Illinois') },
      { name: 'Jarldom of the Northwoods', short: 'Northwoods', type: 'duchy', units: usa('Michigan') },
      { name: 'Republic of Superior', short: 'Superior', type: 'republic', units: usa('Wisconsin') },
    ],
  },
  {
    name: 'The Thunderlands',
    label: { lon: -104.5, lat: 51.5 },
    short: 'THUNDERLANDS',
    type: 'confederation',
    units: [],
    color: ATLAS[7],
    capital: { name: 'Winnipeg', lon: -97.138, lat: 49.895 },
    realms: [
      { name: 'Jarldom of Minnesota', short: 'Minnesota', type: 'duchy', units: usa('Minnesota') },
      { name: 'Jarldom of Sheyenne', short: 'Sheyenne', type: 'duchy', units: usa('North Dakota') },
      { name: 'Kingdom of Lakotah', short: 'Lakotah', type: 'kingdom', units: usa('South Dakota') },
      { name: 'High Chiefdom of Winnipeg', short: 'Winnipeg', type: 'tribal-confederacy', units: can('Manitoba') },
      { name: 'High Chiefdom of Ahtahkakoop', short: 'Ahtahkakoop', type: 'tribal-confederacy', units: can('Saskatchewan') },
      { name: 'Petty Kingdom of Alberta', short: 'Alberta', type: 'kingdom', units: can('Alberta') },
    ],
  },
  {
    name: 'The Rockies',
    label: { lon: -111.5, lat: 43.6 },
    short: 'ROCKIES',
    type: 'confederation',
    units: [],
    color: MUTED[2],
    capital: { name: 'Deseret', lon: -111.891, lat: 40.761 },
    realms: [
      { name: 'Kingdom of Deseret', short: 'Deseret', type: 'kingdom', units: usa('Utah') },
      { name: 'High Chiefdom of Denver', short: 'Denver', type: 'tribal-confederacy', units: usa('Colorado') },
      { name: 'High Chiefdom of Beartooth', short: 'Beartooth', type: 'tribal-confederacy', units: usa('Montana') },
      { name: 'High Chiefdom of West Snake', short: 'West Snake', type: 'tribal-confederacy', units: usa('Idaho') },
      { name: 'High Chiefdom of Highland Springs', short: 'Highland Springs', type: 'tribal-confederacy', units: usa('Wyoming') },
    ],
  },
  {
    name: 'Empire of Cascadia',
    label: { lon: -126.0, lat: 51.0 },
    short: 'CASCADIA',
    type: 'empire',
    units: [...can('Yukon'), ...usa('Alaska')],
    color: MUTED[1],
    capital: { name: 'Seattle', lon: -122.335, lat: 47.608 },
    realms: [
      { name: 'Petty Kingdom of Olympus', short: 'Olympus', type: 'kingdom', units: usa('Washington') },
      { name: 'Kingdom of Lincoln', short: 'Lincoln', type: 'kingdom', units: usa('Oregon') },
      { name: 'Kingdom of Haida Tlagaang', short: 'Haida Tlagaang', type: 'kingdom', units: can('British Columbia') },
    ],
  },
  {
    name: 'Celestial Empire of California',
    label: { lon: -119.0, lat: 37.6 },
    short: 'CALIFORNIA',
    type: 'empire',
    units: usa('California'),
    color: MUTED[3],
    capital: { name: 'Sacramento', lon: -121.494, lat: 38.582 },
    realms: [
      {
        name: 'Kingdom of Baja',
        short: 'Baja',
        type: 'kingdom',
        units: mex('Baja California', 'Baja California Sur'),
      },
      { name: 'High Chiefdom of Death Valley', short: 'Death Valley', type: 'tribal-confederacy', units: usa('Nevada') },
    ],
  },
  {
    name: 'Aztlán',
    label: { lon: -108.5, lat: 26.8 },
    short: 'AZTLÁN',
    type: 'confederation',
    units: [],
    color: MUTED[0],
    capital: { name: 'Chihuahua', lon: -106.089, lat: 28.632 },
    realms: [
      { name: 'Kingdom of Diné Bikéyah', short: 'Diné Bikéyah', type: 'kingdom', units: usa('Arizona') },
      { name: 'High Chiefdom of Nuevo México', short: 'Nuevo México', type: 'tribal-confederacy', units: usa('New Mexico') },
      { name: 'Kingdom of Rio Bravo', short: 'Rio Bravo', type: 'kingdom', units: mex('Chihuahua', 'Coahuila') },
      { name: 'Kingdom of Sierra Madre', short: 'Sierra Madre', type: 'kingdom', units: mex('Durango', 'Sinaloa') },
      { name: 'Duchy of Sonora', short: 'Sonora', type: 'duchy', units: mex('Sonora') },
    ],
  },
  {
    name: 'Empire of Mexico',
    label: { lon: -103.2, lat: 22.4 },
    short: 'MEXICO',
    type: 'empire',
    units: mex(
      'Nuevo León', 'Tamaulipas', 'San Luis Potosí', 'Zacatecas',
      'Aguascalientes', 'Guanajuato', 'Querétaro', 'Nayarit',
    ),
    color: MUTED[4],
    capital: { name: 'México', lon: -99.133, lat: 19.433 },
    realms: [
      {
        name: 'Kingdom of Mexico',
        short: 'Mexico',
        type: 'kingdom',
        units: mex('México', 'Distrito Federal', 'Morelos', 'Hidalgo', 'Tlaxcala', 'Puebla'),
      },
      {
        name: 'Kingdom of Michoacán',
        short: 'Michoacán',
        type: 'kingdom',
        units: mex('Michoacán', 'Colima', 'Jalisco'),
      },
      { name: 'Kingdom of Mixteca', short: 'Mixteca', type: 'kingdom', units: mex('Oaxaca', 'Guerrero') },
      { name: 'Republic of Veracruz', short: 'Veracruz', type: 'republic', units: mex('Veracruz', 'Tabasco') },
    ],
  },
  {
    name: 'Yucatán',
    label: { lon: -88.0, lat: 19.2 },
    short: 'YUCATÁN',
    type: 'kingdom',
    units: [],
    color: MUTED[5],
    capital: { name: 'Mérida', lon: -89.622, lat: 20.967 },
    realms: [
      {
        name: 'Kingdom of Yucatán',
        short: 'Yucatán',
        type: 'kingdom',
        units: mex('Yucatán', 'Quintana Roo', 'Campeche'),
      },
      { name: 'Ajawil of Chiapas', short: 'Chiapas', type: 'principality', units: mex('Chiapas') },
      { name: 'Kingdom of Péten', short: 'Péten', type: 'kingdom', units: ['GTM:Petén'] },
    ],
  },
  {
    name: 'Centroamérica',
    label: { lon: -86.0, lat: 13.2 },
    short: 'CENTROAMÉRICA',
    type: 'confederation',
    units: [
      'BLZ:Belize', 'BLZ:Cayo', 'BLZ:Corozal', 'BLZ:Orange Walk', 'BLZ:Stann Creek', 'BLZ:Toledo',
      'CRI:Alajuela', 'CRI:Cartago', 'CRI:Guanacaste', 'CRI:Heredia', 'CRI:Limón', 'CRI:Puntarenas', 'CRI:San José',
      'PAN:Bocas del Toro', 'PAN:Chiriquí', 'PAN:Coclé', 'PAN:Colón', 'PAN:Darién', 'PAN:Emberá',
      'PAN:Herrera', 'PAN:Kuna Yala', 'PAN:Los Santos', 'PAN:Ngöbe Buglé', 'PAN:Panama', 'PAN:Veraguas',
    ],
    color: MUTED[6],
    capital: { name: 'Guatemala', lon: -90.513, lat: 14.634 },
    realms: [
      {
        name: 'Duchy of Guatemala',
        short: 'Guatemala',
        type: 'duchy',
        units: [
          'GTM:Alta Verapaz', 'GTM:Baja Verapaz', 'GTM:Chimaltenango', 'GTM:Chiquimula',
          'GTM:El Progreso', 'GTM:Escuintla', 'GTM:Guatemala', 'GTM:Huehuetenango', 'GTM:Izabal',
          'GTM:Jalapa', 'GTM:Jutiapa', 'GTM:Quezaltenango', 'GTM:Quiché', 'GTM:Retalhuleu',
          'GTM:Sacatepéquez', 'GTM:San Marcos', 'GTM:Santa Rosa', 'GTM:Sololá',
          'GTM:Suchitepéquez', 'GTM:Totonicapán', 'GTM:Zacapa',
        ],
      },
      {
        name: 'Duchy of Salvador',
        short: 'Salvador',
        type: 'duchy',
        units: [
          'SLV:Ahuachapán', 'SLV:Cabañas', 'SLV:Chalatenango', 'SLV:Cuscatlán', 'SLV:La Libertad',
          'SLV:La Paz', 'SLV:La Unión', 'SLV:Morazán', 'SLV:San Miguel', 'SLV:San Salvador',
          'SLV:San Vicente', 'SLV:Santa Ana', 'SLV:Sonsonate', 'SLV:Usulután',
        ],
      },
      {
        name: 'Marquisate of Atlántida',
        short: 'Atlántida',
        type: 'march',
        units: [
          'HND:Atlántida', 'HND:Choluteca', 'HND:Colón', 'HND:Comayagua', 'HND:Copán', 'HND:Cortés',
          'HND:El Paraíso', 'HND:Francisco Morazán', 'HND:Intibucá', 'HND:Islas de la Bahía',
          'HND:La Paz', 'HND:Lempira', 'HND:Ocotepeque', 'HND:Olancho', 'HND:Santa Bárbara',
          'HND:Valle', 'HND:Yoro',
        ],
      },
      {
        name: 'Duchy of Nicaragua',
        short: 'Nicaragua',
        type: 'duchy',
        units: [
          'NIC:Boaco', 'NIC:Carazo', 'NIC:Chinandega', 'NIC:Chontales', 'NIC:Estelí', 'NIC:Granada',
          'NIC:Jinotega', 'NIC:León', 'NIC:Madriz', 'NIC:Managua', 'NIC:Masaya', 'NIC:Matagalpa',
          'NIC:Nueva Segovia', 'NIC:Rio San Juan', 'NIC:Rivas',
        ],
      },
      {
        name: 'Kingdom of Moskitia',
        short: 'Moskitia',
        type: 'kingdom',
        units: ['HND:Gracias a Dios', 'NIC:Atlántico Norte', 'NIC:Atlántico Sur'],
      },
    ],
  },
  {
    name: 'Caribbean Empire',
    label: { lon: -72.0, lat: 21.6 },
    short: 'CARIBBEAN',
    type: 'empire',
    units: ['PRI:Puerto Rico'],
    color: MUTED[7],
    capital: { name: 'Habana', lon: -82.366, lat: 23.114 },
    realms: [
      {
        name: 'Kingdom of Cuba',
        short: 'Cuba',
        type: 'kingdom',
        units: [
          'CUB:Artemisa', 'CUB:Camagüey', 'CUB:Ciego de Ávila', 'CUB:Cienfuegos',
          'CUB:Ciudad de la Habana', 'CUB:Granma', 'CUB:Guantánamo', 'CUB:Holguín',
          'CUB:Isla de la Juventud', 'CUB:Las Tunas', 'CUB:Matanzas', 'CUB:Mayabeque',
          'CUB:Pinar del Río', 'CUB:Sancti Spíritus', 'CUB:Santiago de Cuba', 'CUB:Villa Clara',
        ],
      },
      {
        name: 'Captaincy of Tortuga',
        short: 'Tortuga',
        type: 'march',
        units: [
          "HTI:Centre", "HTI:Grand'Anse", "HTI:L'Artibonite", 'HTI:Nippes', 'HTI:Nord',
          'HTI:Nord-Est', 'HTI:Nord-Ouest', 'HTI:Ouest', 'HTI:Sud', 'HTI:Sud-Est',
        ],
      },
      {
        name: 'Kingdom of Santo Domingo',
        short: 'Santo Domingo',
        type: 'kingdom',
        units: [
          'DOM:Azua', 'DOM:Bahoruco', 'DOM:Barahona', 'DOM:Dajabón', 'DOM:Distrito Nacional',
          'DOM:Duarte', 'DOM:El Seybo', 'DOM:Espaillat', 'DOM:Hato Mayor', 'DOM:Hermanas',
          'DOM:Independencia', 'DOM:La Altagracia', 'DOM:La Estrelleta', 'DOM:La Romana',
          'DOM:La Vega', 'DOM:María Trinidad Sánchez', 'DOM:Monseñor Nouel', 'DOM:Monte Cristi',
          'DOM:Monte Plata', 'DOM:Pedernales', 'DOM:Peravia', 'DOM:Puerto Plata', 'DOM:Samaná',
          'DOM:San Cristóbal', 'DOM:San José de Ocoa', 'DOM:San Juan', 'DOM:San Pedro de Macorís',
          'DOM:Santiago', 'DOM:Santiago Rodríguez', 'DOM:Santo Domingo', 'DOM:Sánchez Ramírez',
          'DOM:Valverde',
        ],
      },
      {
        name: 'Kingdom of Jamaica',
        short: 'Jamaica',
        type: 'kingdom',
        units: [
          'JAM:Clarendon', 'JAM:Hanover', 'JAM:Kingston', 'JAM:Manchester', 'JAM:Portland',
          'JAM:Saint Andrew', 'JAM:Saint Ann', 'JAM:Saint Catherine', 'JAM:Saint Elizabeth',
          'JAM:Saint James', 'JAM:Saint Mary', 'JAM:Saint Thomas', 'JAM:Trelawny', 'JAM:Westmoreland',
        ],
      },
      {
        name: 'Flotilla of the Leeward Isles',
        short: 'Leeward Isles',
        type: 'march',
        units: [
          'BHS:Acklins', 'BHS:Berry Islands', 'BHS:Bimini', 'BHS:Black Point', 'BHS:Cat Island',
          'BHS:Central Abaco', 'BHS:Central Andros', 'BHS:Central Eleuthera', 'BHS:City of Freeport',
          'BHS:Crooked Island and Long Cay', 'BHS:East Grand Bahama', 'BHS:Exuma',
          'BHS:Harbour Island', 'BHS:Inagua', 'BHS:Long Island', 'BHS:Mangrove Cay',
          'BHS:Mayaguana', "BHS:Moore's Island", 'BHS:New Providence', 'BHS:North Abaco',
          'BHS:North Andros', 'BHS:North Eleuthera', 'BHS:Ragged Island', 'BHS:Rum Cay',
          'BHS:San Salvador', 'BHS:South Abaco', 'BHS:South Andros', 'BHS:South Eleuthera',
          'BHS:Spanish Wells', 'BHS:West Grand Bahama',
        ],
      },
      {
        name: 'Kingdom of Gran Trinidad',
        short: 'Gran Trinidad',
        type: 'kingdom',
        units: [
          'TTO:Arima', 'TTO:Chaguanas', 'TTO:Couva-Tabaquite-Talparo', 'TTO:Diego Martin',
          'TTO:Eastern Tobago', 'TTO:Penal-Debe', 'TTO:Point Fortin', 'TTO:Port of Spain',
          'TTO:Princes Town', 'TTO:Rio Claro-Mayaro', 'TTO:San Fernando',
          'TTO:San Juan-Laventille', 'TTO:Sangre Grande', 'TTO:Siparia', 'TTO:Tunapuna/Piarco',
          'TTO:Western Tobago',
        ],
      },
    ],
  },
];

/** Seas and gulfs, so the water is not anonymous (§12). */
const WATER_LABELS: { text: string; lon: number; lat: number; kind: MapLabel['kind'] }[] = [
  { text: 'Atlantic Ocean', lon: -50, lat: 32, kind: 'ocean' },
  { text: 'Pacific Ocean', lon: -140, lat: 28, kind: 'ocean' },
  { text: 'Gulf of Mexico', lon: -90.5, lat: 25.2, kind: 'water' },
  { text: 'Caribbean Sea', lon: -75.5, lat: 14.5, kind: 'water' },
  { text: 'Hudson Bay', lon: -85.5, lat: 59.5, kind: 'water' },
  { text: 'Gulf of Alaska', lon: -146, lat: 56.5, kind: 'water' },
  { text: 'Labrador Sea', lon: -55.5, lat: 59.5, kind: 'water' },
  { text: 'Bering Sea', lon: -177, lat: 58, kind: 'water' },
  { text: 'Gulf of California', lon: -111.5, lat: 27.5, kind: 'water' },
  { text: 'Baffin Bay', lon: -68, lat: 73.5, kind: 'water' },
];

export interface AfterTheEndResult {
  project: MapProject;
  center: [number, number];
  zoom: number;
}

const CENTER: [number, number] = [-98, 40];
const ZOOM = 3.4;

/**
 * Build the map. Async because it fetches the real subdivision boundaries;
 * returns an empty project if that fetch fails, rather than a half-built one.
 */
export async function buildAfterTheEndProject(): Promise<AfterTheEndResult> {
  const project = createProject({
    title: 'After the End',
    projectionId: 'ATF:LCC',
    center: CENTER,
    zoom: ZOOM,
    // North and Central America and the Caribbean, which is what this map is
    // about; the reference data is cropped to it and the view cannot leave it.
    workingExtent: [-172, 5, -52, 74],
  });
  project.meta.subtitle = 'The realms of the Americas';
  project.meta.dateLine = 'In the Year 2666';
  project.meta.author = 'After the Fall — a map of the After the End setting';
  project.meta.notes =
    'Realm names and their empires follow the After the End realm list. The shapes are ' +
    'approximations onto modern administrative units — the mod\'s own province map is not ' +
    'published as geodata — so treat every border here as a starting point to redraw.';
  project.oceanColor = '#c6dae6';
  project.landColor = '#e9e1d0';
  project.basemap = [
    { sourceId: 'world-land-10m', visible: true, opacity: 1 },
    { sourceId: 'world-lakes-10m', visible: true, opacity: 1 },
    { sourceId: 'world-rivers-10m', visible: false, opacity: 1 },
    { sourceId: 'world-places-10m', visible: false, opacity: 1 },
    { sourceId: 'na-admin1-10m', visible: false, opacity: 1 },
  ];

  const territoryLayer = findLayerByKind(project, 'territory')!;
  const settlementLayer = findLayerByKind(project, 'settlement')!;
  const countryLabels = Object.values(project.layers).find((l) => l.name === 'Country Labels')!;
  const regionLabels = Object.values(project.layers).find((l) => l.name === 'Region Labels')!;
  const cityLabels = Object.values(project.layers).find((l) => l.name === 'City Labels')!;
  const waterLabels = Object.values(project.layers).find((l) => l.name === 'Water Labels')!;

  // Fifty vassal names on top of eighteen empire names is a mat, not a map, and
  // §11 deliberately never drops a label on its own. So the map opens the way an
  // atlas plate would — sovereign realms named, their vassals drawn but silent —
  // and the Region Labels layer turns the rest on in one click.
  project.layers[regionLabels.id] = { ...project.layers[regionLabels.id], visible: false };

  let units: Map<string, Polygon | MultiPolygon>;
  try {
    units = indexUnits(await loadBasemap('na-admin1-10m'));
  } catch {
    return { project, center: CENTER, zoom: ZOOM };
  }

  const missing: string[] = [];
  const geometryOf = (realm: RealmDef): Polygon | MultiPolygon | null => {
    const parts: (Polygon | MultiPolygon)[] = [];
    const collect = (r: RealmDef) => {
      for (const key of r.units) {
        const g = units.get(key.toLowerCase());
        if (g) parts.push(g);
        else missing.push(key);
      }
      for (const child of r.realms ?? []) collect(child);
    };
    collect(realm);
    return parts.length ? dissolve(parts) : null;
  };

  for (const empire of EMPIRES) {
    const geometry = geometryOf(empire);
    if (!geometry) continue;

    const empireId = newId();
    const capitalId = empire.capital ? newId() : null;

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
      geometry,
      styleClassId: STYLE_IDS.territoryDefault,
      styleOverrides: { fillColor: empire.color ?? ATLAS[0] },
      inheritParentColor: false,
      borderKind: 'international',
      labelId: null,
    };
    attachLabel(project, empireId, {
      layerId: countryLabels.id,
      kind: 'country',
      text: empire.short,
      coords: empire.label ? [empire.label.lon, empire.label.lat] : interiorPoint(geometry),
      styleClassId: STYLE_IDS.textCountry,
      // A hand-placed name must survive the automatic placement pass (§11).
      manualPosition: !!empire.label,
      // Smaller and more tightly tracked than the default country style. That
      // default is set for a plate showing one realm; here eighteen of them
      // share a continent, and at full tracking a single name is wider than the
      // realm it belongs to. Every one is still an ordinary override you can
      // change in the Styles panel.
      style: { fontSize: 11, tracking: 2.2 },
    });

    // Vassal realms: same colour family as their liege, thin subordinate borders.
    for (const realm of empire.realms ?? []) {
      const childGeometry = geometryOf(realm);
      if (!childGeometry) continue;
      const childId = newId();
      project.territories[childId] = {
        ...project.territories[empireId],
        id: childId,
        name: realm.name,
        shortName: realm.short,
        politicalType: realm.type,
        parentId: empireId,
        liegeId: empireId,
        capitalId: null,
        geometry: childGeometry,
        styleOverrides: {},
        // §7: a vassal takes its liege's colour unless it is given its own.
        inheritParentColor: true,
        borderKind: 'subordinate',
        labelId: null,
      };
      attachLabel(project, childId, {
        layerId: regionLabels.id,
        kind: 'region',
        text: realm.short,
        coords: interiorPoint(childGeometry),
        styleClassId: STYLE_IDS.textRegion,
      });
    }

    if (empire.capital && capitalId) {
      const seat: Settlement = {
        id: capitalId,
        layerId: settlementLayer.id,
        name: empire.capital.name,
        notes: '',
        locked: false,
        hidden: false,
        timeline: { start: null, end: null },
        type: 'national-capital',
        geometry: { type: 'Point', coordinates: [empire.capital.lon, empire.capital.lat] },
        population: null,
        ownerId: empireId,
        styleClassId: STYLE_IDS.symbolCapitalNational,
        styleOverrides: {},
        labelId: null,
      };
      project.settlements[capitalId] = seat;
      attachLabel(project, capitalId, {
        layerId: cityLabels.id,
        kind: 'city',
        text: seat.name,
        coords: [empire.capital.lon, empire.capital.lat],
        styleClassId: STYLE_IDS.textCapital,
        offset: [11, 0],
        target: 'settlements',
      });
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

  if (missing.length) {
    // Loud in development, invisible to the user: a renamed subdivision would
    // otherwise silently shrink a realm.
    console.warn(`After the End: ${missing.length} unmatched subdivisions`, missing);
  }

  return { project, center: CENTER, zoom: ZOOM };
}

/** `ISO3:name` → geometry, lowercased so the realm table can be written naturally. */
function indexUnits(features: Awaited<ReturnType<typeof loadBasemap>>) {
  const index = new Map<string, Polygon | MultiPolygon>();
  for (const f of polygonsOf(features)) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const country = typeof props.adm0_a3 === 'string' ? props.adm0_a3 : '';
    const name = basemapFeatureName(f);
    if (!country || !name) continue;
    index.set(`${country}:${name}`.toLowerCase(), f.geometry as Polygon | MultiPolygon);
  }
  return index;
}

function attachLabel(
  project: MapProject,
  ownerId: string,
  init: Parameters<typeof makeLabel>[0] & { target?: 'territories' | 'settlements' },
): void {
  const label = makeLabel({ ...init, attachedToId: ownerId });
  project.labels[label.id] = label;
  const collection = init.target === 'settlements' ? project.settlements : project.territories;
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
  style?: Partial<TextStyle>;
}): MapLabel {
  return {
    id: newId(),
    layerId: init.layerId,
    name: init.text,
    notes: '',
    locked: false,
    hidden: false,
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

/** Exposed for tests: the realm table, so its shape can be checked without a fetch. */
export const AFTER_THE_END_EMPIRES: readonly RealmDef[] = EMPIRES;

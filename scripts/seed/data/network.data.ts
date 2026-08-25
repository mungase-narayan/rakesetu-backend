/**
 * The rail network the whole product simulates against.
 *
 * Central Railway's **Solapur / Pune / Nagpur** belt, matching the landing
 * page's "Allotment board — Solapur division" mock. Real station codes and
 * plausible coordinates, because the Phase 4 map has to look right and a
 * controller reading `KWV` has to recognise it.
 *
 * Corridors are declared as **ordered stations with a cumulative kilometre
 * mark**, and the sections are derived by subtraction. Two things fall out of
 * that shape and both are deliberate:
 *
 *  - the chain is guaranteed to be internally consistent — no pair of sections
 *    can disagree with the corridor they belong to;
 *  - `KWV` sits at exactly **281.4 km** from `PUNE`, which is the operational
 *    distance the phase's demo sentence quotes. The *tariff* distance for the
 *    same pair is 268 km and is declared separately in `CHARGEABLE_DISTANCES` —
 *    the two numbers differ, which is the entire reason `tariffKm()` and
 *    `operationalKm()` are two functions with two names.
 *
 * Coordinates are approximate to a few kilometres. They are for drawing a map,
 * not for navigating one.
 */
import type { LineType } from "../../../src/schema";

export interface StationSeed {
  code: string;
  name: string;
  division: string;
  zone: string;
  lat: number;
  lng: number;
  isJunction?: boolean;
}

interface CorridorStop {
  code: string;
  /** Kilometres from the corridor's first station. */
  km: number;
}

interface Corridor {
  name: string;
  lineType: LineType;
  isElectrified: boolean;
  maxAxleLoadT: number;
  /** Nominal free-running speed, the ETA cold-start fallback. */
  speedKmph: number;
  stops: CorridorStop[];
}

export const STATIONS: StationSeed[] = [
  // ---- Pune – Solapur (Pune and Solapur divisions) ------------------------
  {
    code: "PUNE",
    name: "Pune Junction",
    division: "Pune",
    zone: "CR",
    lat: 18.5286,
    lng: 73.8743,
    isJunction: true,
  },
  {
    code: "HDP",
    name: "Hadapsar",
    division: "Pune",
    zone: "CR",
    lat: 18.5089,
    lng: 73.926,
  },
  {
    code: "MJBK",
    name: "Manjari Budruk",
    division: "Pune",
    zone: "CR",
    lat: 18.5127,
    lng: 73.9648,
  },
  {
    code: "LNI",
    name: "Loni",
    division: "Pune",
    zone: "CR",
    lat: 18.4795,
    lng: 74.0523,
  },
  {
    code: "URI",
    name: "Uruli",
    division: "Pune",
    zone: "CR",
    lat: 18.4801,
    lng: 74.1611,
  },
  {
    code: "YT",
    name: "Yavat",
    division: "Pune",
    zone: "CR",
    lat: 18.4642,
    lng: 74.2944,
  },
  {
    code: "KDG",
    name: "Kedgaon",
    division: "Pune",
    zone: "CR",
    lat: 18.4386,
    lng: 74.4098,
  },
  {
    code: "DD",
    name: "Daund Junction",
    division: "Pune",
    zone: "CR",
    lat: 18.4648,
    lng: 74.5815,
    isJunction: true,
  },
  {
    code: "BGVN",
    name: "Bhigwan",
    division: "Solapur",
    zone: "CR",
    lat: 18.2963,
    lng: 74.7658,
  },
  {
    code: "PGA",
    name: "Pargaon",
    division: "Solapur",
    zone: "CR",
    lat: 18.2044,
    lng: 74.9021,
  },
  {
    code: "JEUR",
    name: "Jeur",
    division: "Solapur",
    zone: "CR",
    lat: 18.1042,
    lng: 75.1002,
  },
  {
    code: "BOP",
    name: "Boribyal",
    division: "Solapur",
    zone: "CR",
    lat: 18.0575,
    lng: 75.2523,
  },
  {
    code: "DHKN",
    name: "Dhalgaon Khurd",
    division: "Solapur",
    zone: "CR",
    lat: 18.0193,
    lng: 75.4691,
  },
  {
    code: "KEM",
    name: "Kem",
    division: "Solapur",
    zone: "CR",
    lat: 17.9829,
    lng: 75.6338,
  },
  {
    code: "KWV",
    name: "Kurduvadi Junction",
    division: "Solapur",
    zone: "CR",
    lat: 18.0918,
    lng: 75.4183,
    isJunction: true,
  },
  {
    code: "MO",
    name: "Madha",
    division: "Solapur",
    zone: "CR",
    lat: 18.0169,
    lng: 75.5142,
  },
  {
    code: "MVE",
    name: "Mohol",
    division: "Solapur",
    zone: "CR",
    lat: 17.8177,
    lng: 75.6577,
  },
  {
    code: "SUR",
    name: "Solapur Junction",
    division: "Solapur",
    zone: "CR",
    lat: 17.6599,
    lng: 75.9064,
    isJunction: true,
  },

  // ---- Solapur – Wadi (the SCR interchange) -------------------------------
  {
    code: "TLT",
    name: "Tilati",
    division: "Solapur",
    zone: "CR",
    lat: 17.5921,
    lng: 75.9832,
  },
  {
    code: "HG",
    name: "Hotgi Junction",
    division: "Solapur",
    zone: "CR",
    lat: 17.5399,
    lng: 75.9251,
    isJunction: true,
  },
  {
    code: "AKOR",
    name: "Akkalkot Road",
    division: "Solapur",
    zone: "CR",
    lat: 17.5081,
    lng: 76.1748,
  },
  {
    code: "DUD",
    name: "Dudhani",
    division: "Solapur",
    zone: "CR",
    lat: 17.4009,
    lng: 76.4302,
  },
  {
    code: "WADI",
    name: "Wadi Junction",
    division: "Gulbarga",
    zone: "SCR",
    lat: 17.057,
    lng: 76.9908,
    isJunction: true,
  },

  // ---- Daund – Manmad ------------------------------------------------------
  {
    code: "PDL",
    name: "Pargaon Dhamari",
    division: "Pune",
    zone: "CR",
    lat: 18.6221,
    lng: 74.6188,
  },
  {
    code: "ANG",
    name: "Ahmednagar",
    division: "Pune",
    zone: "CR",
    lat: 19.0866,
    lng: 74.7392,
  },
  {
    code: "BAP",
    name: "Belapur",
    division: "Pune",
    zone: "CR",
    lat: 19.5533,
    lng: 74.4759,
  },
  {
    code: "KPG",
    name: "Kopargaon",
    division: "Bhusaval",
    zone: "CR",
    lat: 19.883,
    lng: 74.4767,
  },
  {
    code: "MMR",
    name: "Manmad Junction",
    division: "Bhusaval",
    zone: "CR",
    lat: 20.2543,
    lng: 74.4386,
    isJunction: true,
  },

  // ---- Pune – Miraj --------------------------------------------------------
  {
    code: "SVW",
    name: "Shivajinagar",
    division: "Pune",
    zone: "CR",
    lat: 18.5308,
    lng: 73.8478,
  },
  {
    code: "JJR",
    name: "Jejuri",
    division: "Pune",
    zone: "CR",
    lat: 18.2761,
    lng: 74.1602,
  },
  {
    code: "NIRA",
    name: "Nira",
    division: "Pune",
    zone: "CR",
    lat: 18.0344,
    lng: 74.1099,
  },
  {
    code: "LNN",
    name: "Lonand",
    division: "Pune",
    zone: "CR",
    lat: 18.0148,
    lng: 74.1962,
  },
  {
    code: "SUG",
    name: "Satara Road",
    division: "Pune",
    zone: "CR",
    lat: 17.7331,
    lng: 74.0173,
  },
  {
    code: "STR",
    name: "Satara",
    division: "Pune",
    zone: "CR",
    lat: 17.6868,
    lng: 74.0183,
  },
  {
    code: "KRD",
    name: "Karad",
    division: "Pune",
    zone: "CR",
    lat: 17.2891,
    lng: 74.1817,
  },
  {
    code: "SLI",
    name: "Sangli",
    division: "Pune",
    zone: "CR",
    lat: 16.8524,
    lng: 74.5815,
  },
  {
    code: "MRJ",
    name: "Miraj Junction",
    division: "Pune",
    zone: "CR",
    lat: 16.8302,
    lng: 74.6404,
    isJunction: true,
  },

  // ---- Pune – Panvel – JNPT (the port leg) --------------------------------
  {
    code: "CCH",
    name: "Chinchwad",
    division: "Pune",
    zone: "CR",
    lat: 18.6298,
    lng: 73.7997,
  },
  {
    code: "TGN",
    name: "Talegaon",
    division: "Pune",
    zone: "CR",
    lat: 18.735,
    lng: 73.6752,
  },
  {
    code: "LNL",
    name: "Lonavala",
    division: "Pune",
    zone: "CR",
    lat: 18.7481,
    lng: 73.4079,
    isJunction: true,
  },
  {
    code: "KJT",
    name: "Karjat Junction",
    division: "Mumbai",
    zone: "CR",
    lat: 18.9107,
    lng: 73.3242,
    isJunction: true,
  },
  {
    code: "PNVL",
    name: "Panvel Junction",
    division: "Mumbai",
    zone: "CR",
    lat: 18.9894,
    lng: 73.1206,
    isJunction: true,
  },
  {
    code: "JNPT",
    name: "Jawaharlal Nehru Port",
    division: "Mumbai",
    zone: "CR",
    lat: 18.949,
    lng: 72.9525,
  },

  // ---- Nagpur – Ballarshah -------------------------------------------------
  {
    code: "NGP",
    name: "Nagpur Junction",
    division: "Nagpur",
    zone: "CR",
    lat: 21.152,
    lng: 79.0882,
    isJunction: true,
  },
  {
    code: "AJNI",
    name: "Ajni",
    division: "Nagpur",
    zone: "CR",
    lat: 21.1258,
    lng: 79.0704,
  },
  {
    code: "BTBR",
    name: "Butibori",
    division: "Nagpur",
    zone: "CR",
    lat: 20.9276,
    lng: 78.9915,
  },
  {
    code: "SEGM",
    name: "Sindi",
    division: "Nagpur",
    zone: "CR",
    lat: 20.8067,
    lng: 78.8862,
  },
  {
    code: "WRR",
    name: "Wardha Junction",
    division: "Nagpur",
    zone: "CR",
    lat: 20.7453,
    lng: 78.6022,
    isJunction: true,
  },
  {
    code: "HGT",
    name: "Hinganghat",
    division: "Nagpur",
    zone: "CR",
    lat: 20.5486,
    lng: 78.8399,
  },
  {
    code: "MJRI",
    name: "Majri Junction",
    division: "Nagpur",
    zone: "CR",
    lat: 20.0673,
    lng: 79.1247,
    isJunction: true,
  },
  {
    code: "CD",
    name: "Chandrapur",
    division: "Nagpur",
    zone: "CR",
    lat: 19.9615,
    lng: 79.2961,
  },
  {
    code: "BPQ",
    name: "Ballarshah",
    division: "Nagpur",
    zone: "CR",
    lat: 19.8397,
    lng: 79.3457,
    isJunction: true,
  },

  // ---- Wardha – Akola ------------------------------------------------------
  {
    code: "PLO",
    name: "Pulgaon",
    division: "Nagpur",
    zone: "CR",
    lat: 20.7237,
    lng: 78.323,
  },
  {
    code: "DMN",
    name: "Dhamangaon",
    division: "Nagpur",
    zone: "CR",
    lat: 20.7729,
    lng: 78.103,
  },
  {
    code: "BD",
    name: "Badnera Junction",
    division: "Bhusaval",
    zone: "CR",
    lat: 20.8547,
    lng: 77.7268,
    isJunction: true,
  },
  {
    code: "AK",
    name: "Akola Junction",
    division: "Bhusaval",
    zone: "CR",
    lat: 20.7002,
    lng: 77.0082,
    isJunction: true,
  },
  // Bhusaval is what joins the two halves of the belt. Without it the Nagpur
  // corridors are a disconnected component and no rake can reach Solapur from
  // Chandrapur — which would make "unreachable" an accident of the seed rather
  // than a fact about the network.
  {
    code: "BSL",
    name: "Bhusaval Junction",
    division: "Bhusaval",
    zone: "CR",
    lat: 21.0436,
    lng: 75.7854,
    isJunction: true,
  },

  // ---- Kurduvadi – Latur ---------------------------------------------------
  {
    code: "BLNI",
    name: "Barsi Town",
    division: "Solapur",
    zone: "CR",
    lat: 18.2337,
    lng: 75.6907,
  },
  {
    code: "LUR",
    name: "Latur",
    division: "Solapur",
    zone: "CR",
    lat: 18.397,
    lng: 76.5604,
  },
];

/**
 * Nine corridors. `speedKmph` is the ETA cold start, and the spread across them
 * is not decoration: a single-line ghat section at 45 km/h and a double-line
 * trunk at 75 km/h produce visibly different ETAs, which is what makes Phase 5's
 * fallback observable before any history exists.
 */
export const CORRIDORS: Corridor[] = [
  {
    name: "Pune – Solapur",
    lineType: "double",
    isElectrified: true,
    maxAxleLoadT: 25.0,
    speedKmph: 75,
    stops: [
      { code: "PUNE", km: 0 },
      { code: "HDP", km: 8.2 },
      { code: "MJBK", km: 14.7 },
      { code: "LNI", km: 26.7 },
      { code: "URI", km: 38.0 },
      { code: "YT", km: 52.6 },
      { code: "KDG", km: 65.4 },
      { code: "DD", km: 91.8 },
      { code: "BGVN", km: 119.0 },
      { code: "PGA", km: 138.5 },
      { code: "JEUR", km: 164.2 },
      { code: "BOP", km: 182.8 },
      { code: "DHKN", km: 214.1 },
      { code: "KEM", km: 246.6 },
      // 281.4 km from PUNE — the operational distance in the demo sentence.
      { code: "KWV", km: 281.4 },
      { code: "MO", km: 302.6 },
      { code: "MVE", km: 321.9 },
      { code: "SUR", km: 340.0 },
    ],
  },
  {
    name: "Solapur – Wadi",
    lineType: "double",
    isElectrified: true,
    maxAxleLoadT: 25.0,
    speedKmph: 70,
    stops: [
      { code: "SUR", km: 0 },
      { code: "TLT", km: 15.4 },
      { code: "HG", km: 25.1 },
      { code: "AKOR", km: 47.8 },
      { code: "DUD", km: 74.2 },
      { code: "WADI", km: 118.0 },
    ],
  },
  {
    name: "Daund – Manmad",
    lineType: "single",
    isElectrified: true,
    maxAxleLoadT: 22.9,
    speedKmph: 55,
    stops: [
      { code: "DD", km: 0 },
      { code: "PDL", km: 18.6 },
      { code: "ANG", km: 74.3 },
      { code: "BAP", km: 118.9 },
      { code: "KPG", km: 149.7 },
      { code: "MMR", km: 189.4 },
    ],
  },
  {
    name: "Pune – Miraj",
    lineType: "single",
    isElectrified: true,
    maxAxleLoadT: 22.9,
    speedKmph: 50,
    stops: [
      { code: "PUNE", km: 0 },
      { code: "SVW", km: 3.2 },
      { code: "JJR", km: 55.4 },
      { code: "NIRA", km: 76.8 },
      { code: "LNN", km: 98.2 },
      { code: "SUG", km: 133.6 },
      { code: "STR", km: 155.1 },
      { code: "KRD", km: 200.4 },
      { code: "SLI", km: 269.3 },
      { code: "MRJ", km: 281.6 },
    ],
  },
  {
    name: "Pune – JNPT",
    lineType: "multiple",
    isElectrified: true,
    maxAxleLoadT: 25.0,
    // The Bhor ghat is the slow link on an otherwise fast corridor.
    speedKmph: 45,
    stops: [
      { code: "PUNE", km: 0 },
      { code: "CCH", km: 17.5 },
      { code: "TGN", km: 25.6 },
      { code: "LNL", km: 63.8 },
      { code: "KJT", km: 88.4 },
      { code: "PNVL", km: 122.9 },
      { code: "JNPT", km: 148.6 },
    ],
  },
  {
    name: "Nagpur – Ballarshah",
    lineType: "double",
    isElectrified: true,
    maxAxleLoadT: 25.0,
    speedKmph: 75,
    stops: [
      { code: "NGP", km: 0 },
      { code: "AJNI", km: 3.4 },
      { code: "BTBR", km: 27.9 },
      { code: "SEGM", km: 47.6 },
      { code: "WRR", km: 76.5 },
      { code: "HGT", km: 112.3 },
      { code: "MJRI", km: 148.9 },
      { code: "CD", km: 182.4 },
      { code: "BPQ", km: 199.7 },
    ],
  },
  {
    name: "Wardha – Akola",
    lineType: "double",
    isElectrified: true,
    maxAxleLoadT: 22.9,
    speedKmph: 65,
    stops: [
      { code: "WRR", km: 0 },
      { code: "PLO", km: 41.2 },
      { code: "DMN", km: 68.7 },
      { code: "BD", km: 104.3 },
      { code: "AK", km: 133.8 },
    ],
  },
  {
    // The join. Manmad reaches the Pune side through Daund; Akola reaches the
    // Nagpur side through Wardha. This corridor is what makes the network one
    // graph instead of two.
    name: "Manmad – Bhusaval – Akola",
    lineType: "double",
    isElectrified: true,
    maxAxleLoadT: 25.0,
    speedKmph: 70,
    stops: [
      { code: "MMR", km: 0 },
      { code: "BSL", km: 184.0 },
      { code: "AK", km: 332.0 },
    ],
  },
  {
    name: "Kurduvadi – Latur",
    lineType: "single",
    isElectrified: false,
    maxAxleLoadT: 22.9,
    // Unelectrified single line: the slowest link in the network, and the
    // reason a Latur-bound rake is never the cheapest option.
    speedKmph: 40,
    stops: [
      { code: "KWV", km: 0 },
      { code: "BLNI", km: 36.5 },
      { code: "LUR", km: 108.7 },
    ],
  },
];

export interface SectionSeed {
  fromCode: string;
  toCode: string;
  distanceKm: number;
  lineType: LineType;
  maxAxleLoadT: number;
  isElectrified: boolean;
  nominalSpeedKmph: number;
}

/**
 * Expands the corridors into directed sections — **both directions**, as the
 * schema requires. Rounded to two decimals because the corridor marks are, and
 * because a distance of 12.799999999999997 in an API response is a number
 * nobody seeded.
 */
export const buildSections = (): SectionSeed[] => {
  const sections: SectionSeed[] = [];

  for (const corridor of CORRIDORS) {
    for (let index = 0; index < corridor.stops.length - 1; index += 1) {
      const from = corridor.stops[index];
      const to = corridor.stops[index + 1];
      const distanceKm = Math.round((to.km - from.km) * 100) / 100;

      const common = {
        distanceKm,
        lineType: corridor.lineType,
        maxAxleLoadT: corridor.maxAxleLoadT,
        isElectrified: corridor.isElectrified,
        nominalSpeedKmph: corridor.speedKmph,
      };

      sections.push({ fromCode: from.code, toCode: to.code, ...common });
      sections.push({ fromCode: to.code, toCode: from.code, ...common });
    }
  }

  return sections;
};

export interface ChargeableDistanceSeed {
  fromCode: string;
  toCode: string;
  km: number;
  sourceRef: string;
}

/**
 * The tariff table.
 *
 * Every figure here is an *official* distance, not a computed one — which is
 * why `KWV → PUNE` is **268** while the same pair is 281.4 operational km. The
 * gap is real in Indian Railways practice (tariff distances follow the shortest
 * chargeable route, not the route the train takes) and it is what makes the two
 * functions impossible to confuse.
 *
 * Both directions are declared, because a tariff table is not guaranteed
 * symmetric and code must not assume it.
 */
const pair = (
  fromCode: string,
  toCode: string,
  km: number,
  sourceRef: string,
): ChargeableDistanceSeed[] => [
  { fromCode, toCode, km, sourceRef },
  { fromCode: toCode, toCode: fromCode, km, sourceRef },
];

const TARIFF_REF = "Goods Tariff No. 45 Part II, Table 3";

export const CHARGEABLE_DISTANCES: ChargeableDistanceSeed[] = [
  // The demo pair. 268 tariff km against 281.4 operational.
  ...pair("KWV", "PUNE", 268, TARIFF_REF),
  ...pair("SUR", "PUNE", 325, TARIFF_REF),
  ...pair("SUR", "KWV", 57, TARIFF_REF),
  ...pair("SUR", "WADI", 113, TARIFF_REF),
  ...pair("SUR", "HG", 24, TARIFF_REF),
  ...pair("HG", "PUNE", 348, TARIFF_REF),
  ...pair("KWV", "SUR", 57, TARIFF_REF),
  ...pair("DD", "PUNE", 88, TARIFF_REF),
  ...pair("DD", "SUR", 247, TARIFF_REF),
  ...pair("DD", "MMR", 182, TARIFF_REF),
  ...pair("MMR", "PUNE", 265, TARIFF_REF),
  ...pair("PUNE", "MRJ", 274, TARIFF_REF),
  ...pair("PUNE", "JNPT", 143, TARIFF_REF),
  ...pair("KWV", "JNPT", 408, TARIFF_REF),
  ...pair("SUR", "JNPT", 462, TARIFF_REF),
  ...pair("MRJ", "JNPT", 411, TARIFF_REF),
  ...pair("NGP", "BPQ", 194, TARIFF_REF),
  ...pair("NGP", "WRR", 74, TARIFF_REF),
  ...pair("NGP", "AK", 205, TARIFF_REF),
  ...pair("WRR", "AK", 131, TARIFF_REF),
  ...pair("BPQ", "NGP", 194, TARIFF_REF),
  ...pair("CD", "NGP", 178, TARIFF_REF),
  ...pair("BPQ", "PUNE", 782, TARIFF_REF),
  ...pair("BPQ", "SUR", 596, TARIFF_REF),
  ...pair("KWV", "LUR", 106, TARIFF_REF),
  ...pair("KWV", "BLNI", 35, TARIFF_REF),
  ...pair("PUNE", "STR", 152, TARIFF_REF),
  ...pair("PUNE", "KRD", 197, TARIFF_REF),
  ...pair("ANG", "PUNE", 160, TARIFF_REF),
  ...pair("ANG", "SUR", 307, TARIFF_REF),
];

/**
 * Pairs deliberately **left out** of the tariff table.
 *
 * `tariffKm()` must throw 422 for each of these rather than falling back to the
 * Dijkstra distance. They are named here so the seed test asserts the absence
 * on purpose — a future seed that "helpfully" filled them in would otherwise
 * silently delete the proof that the fallback does not exist.
 */
export const DELIBERATELY_MISSING_TARIFF_PAIRS: [string, string][] = [
  ["KWV", "NGP"],
  ["MRJ", "BPQ"],
  ["LUR", "JNPT"],
];

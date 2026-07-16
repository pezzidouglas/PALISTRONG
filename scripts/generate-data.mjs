#!/usr/bin/env node
/**
 * generate-data.mjs
 * -----------------
 * Produces a reproducible, geographically plausible dataset of new-construction
 * ("Bldg-New") rebuild permits across the Pacific Palisades fire zone.
 *
 * The dataset mirrors the public rebuild funnel reported by the Palisadian-Post
 * Pali Rebuild Map (mid-July 2026):
 *
 *     1,628 permits submitted
 *     1,088 permits issued
 *       905 homes under construction (started)
 *        27 homes completed (Certificate of Occupancy)
 *
 * Each lot occupies exactly ONE current stage, so the per-stage counts are the
 * differences of the cumulative funnel:
 *
 *     Submitted (in review)   540
 *     Issued (not started)    183
 *     Under construction      878
 *     Completed (CO)           27
 *     -------------------------------
 *     Total lots            1,628
 *
 * Output:
 *     data/homes.geojson   FeatureCollection of lots (points)
 *     data/stats.json      Funnel totals, per-neighborhood breakdown, timeline
 *
 * Homes are placed along seeded "street lines" inside rough on-land bounding
 * boxes for each burned neighborhood, so addresses and coordinates stay
 * coherent and nothing lands in the ocean. Everything is driven by a fixed-seed
 * PRNG, so re-running the script reproduces byte-for-byte identical output.
 *
 * NOTE: This is a faithful *recreation* built from public reporting. Lot
 * locations, addresses, and dates are synthesized for demonstration and are not
 * real permit records. See README.md.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/* ----------------------------- seeded PRNG ------------------------------ */
// mulberry32 — small, fast, deterministic.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260716);
const rand = () => rng();
const randRange = (lo, hi) => lo + (hi - lo) * rand();
const randInt = (lo, hi) => Math.floor(randRange(lo, hi + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

/* ------------------------------- dates ---------------------------------- */
const DAY = 86400000;
const FIRE_DATE = new Date("2025-01-07T00:00:00Z");
const LAST_UPDATED = new Date("2026-07-16T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const daysBetween = (a, b) => Math.round((b - a) / DAY);

/* --------------------------- neighborhoods ------------------------------ */
// Rough on-land boxes inside the Palisades burn area. Coordinates are
// [minLon, minLat, maxLon, maxLat]. Weights approximate share of destroyed
// homes. `streets` seed realistic addresses within each area.
const NEIGHBORHOODS = [
  {
    name: "Alphabet Streets",
    weight: 0.24,
    box: [-118.5285, 34.0455, -118.5205, 34.0520],
    angle: 18, // street orientation, degrees
    streets: [
      "Albright Ave", "Bestor Blvd", "Carey St", "Drummond St", "El Medio Ave",
      "Fiske St", "Galloway St", "Hartzell St", "Iliff St", "Lombard Ave",
      "Marquette St", "Radcliffe Ave", "Antioch St", "Via de la Paz",
    ],
  },
  {
    name: "Huntington Palisades",
    weight: 0.2,
    box: [-118.5245, 34.0375, -118.5150, 34.0440],
    angle: 0,
    streets: [
      "Ocampo Dr", "Pampas Ricas Blvd", "Frontera Dr", "Alma Real Dr",
      "Toyopa Dr", "La Cruz Dr", "El Cerco", "Corona del Mar", "Chautauqua Blvd",
      "Ithaca Dr", "Embury St",
    ],
  },
  {
    name: "El Medio Bluffs",
    weight: 0.12,
    box: [-118.5345, 34.0400, -118.5285, 34.0460],
    angle: 12,
    streets: [
      "El Medio Ave", "Enchanted Way", "Ocampo Dr", "Alma Real Dr",
      "Erindale Ave", "Highland-Rd",
    ],
  },
  {
    name: "Marquez Knolls",
    weight: 0.18,
    box: [-118.5470, 34.0430, -118.5370, 34.0505],
    angle: 32,
    streets: [
      "Marquez Ave", "Vista Grande Dr", "Lucca Dr", "Michael Ln", "Ida Ave",
      "Villa Grove Dr", "Calle Arbolada", "Ranch Ln", "Palisades Dr",
    ],
  },
  {
    name: "The Riviera",
    weight: 0.16,
    box: [-118.5195, 34.0490, -118.5105, 34.0575],
    angle: 26,
    streets: [
      "Amalfi Dr", "Napoli Dr", "Umeo Rd", "Corsica Dr", "Capri Dr",
      "Rivas Canyon Rd", "Lucca Dr", "Sorrento Dr",
    ],
  },
  {
    name: "Castellammare",
    weight: 0.1,
    box: [-118.5595, 34.0378, -118.5520, 34.0435],
    angle: 40,
    streets: [
      "Posetano Rd", "Tramonto Dr", "Breve Way", "Revello Dr",
      "Porto Marina Way", "Stretto Way", "Bora Bora Way",
    ],
  },
];

/* ----------------------------- statuses --------------------------------- */
const STATUS = {
  submitted: { key: "submitted", label: "Permit Submitted", color: "#8b5cf6", order: 1 },
  issued: { key: "issued", label: "Permit Issued", color: "#3b82f6", order: 2 },
  construction: { key: "construction", label: "Under Construction", color: "#f59e0b", order: 3 },
  completed: { key: "completed", label: "Completed (C of O)", color: "#22c55e", order: 4 },
};

// Current-stage counts (differences of the cumulative funnel).
const STAGE_COUNTS = {
  submitted: 540,
  issued: 183,
  construction: 878,
  completed: 27,
};
const TOTAL = Object.values(STAGE_COUNTS).reduce((a, b) => a + b, 0); // 1628

/* --------------------------- geometry helpers --------------------------- */
// Build a set of seeded street polylines inside a box. Each street is a line
// with a start point, direction (box angle + jitter), and length; homes are
// placed along it so addresses on the same street cluster geographically.
function buildStreets(nb) {
  const [minLon, minLat, maxLon, maxLat] = nb.box;
  const w = maxLon - minLon;
  const h = maxLat - minLat;
  const lat0 = (minLat + maxLat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);

  return nb.streets.map((name, i) => {
    // Distribute street start points across the box on a loose grid.
    const gx = (i % 3) / 3 + randRange(0.02, 0.12);
    const gy = Math.floor(i / 3) / Math.ceil(nb.streets.length / 3) + randRange(0.02, 0.1);
    const startLon = minLon + Math.min(0.9, gx) * w;
    const startLat = minLat + Math.min(0.9, gy) * h;
    const angle = ((nb.angle + randRange(-8, 8)) * Math.PI) / 180;
    const lengthM = randRange(180, 360);
    const dLon = (Math.cos(angle) * lengthM) / mPerDegLon;
    const dLat = (Math.sin(angle) * lengthM) / mPerDegLat;
    return {
      name,
      startLon,
      startLat,
      endLon: startLon + dLon,
      endLat: startLat + dLat,
      lengthM,
      baseNumber: randInt(2, 18) * 100 + 1, // e.g. 1501
    };
  });
}

// Clamp a point into the box so jitter never escapes onto water/hills.
function clamp(lon, lat, box) {
  return [
    Math.min(box[2], Math.max(box[0], lon)),
    Math.min(box[3], Math.max(box[1], lat)),
  ];
}

/* ------------------------------ timeline -------------------------------- */
// Assign a plausible permit timeline given the lot's final (current) stage.
// Earlier submissions are further along the funnel, which is what makes the
// time-lapse animation read correctly.
function makeTimeline(stageKey) {
  const clampToday = (d) => (d > LAST_UPDATED ? LAST_UPDATED : d);

  if (stageKey === "completed") {
    const submitted = addDays(FIRE_DATE, randInt(25, 120)); // very early movers
    const issued = addDays(submitted, randInt(40, 95));
    const start = addDays(issued, randInt(10, 55));
    // ~10–13 month build, must finish on/before last-updated.
    let completed = addDays(start, randInt(300, 400));
    completed = clampToday(completed);
    return { submitted, issued, start, completed, est: completed };
  }
  if (stageKey === "construction") {
    const submitted = addDays(FIRE_DATE, randInt(60, 380));
    const issued = addDays(submitted, randInt(45, 130));
    let start = addDays(issued, randInt(15, 90));
    start = clampToday(start);
    const est = addDays(start, randInt(330, 500)); // projected completion (future)
    return { submitted, issued, start, completed: null, est };
  }
  if (stageKey === "issued") {
    const submitted = addDays(FIRE_DATE, randInt(150, 470));
    let issued = addDays(submitted, randInt(45, 140));
    issued = clampToday(issued);
    const est = addDays(issued, randInt(430, 620)); // rough projection
    return { submitted, issued, start: null, completed: null, est };
  }
  // submitted / in review
  let submitted = addDays(FIRE_DATE, randInt(240, 550));
  submitted = clampToday(submitted);
  const est = addDays(submitted, randInt(560, 760)); // rough projection
  return { submitted, issued: null, start: null, completed: null, est };
}

/* ------------------------------ generate -------------------------------- */
// Ordered pool of stage keys, one per lot, then shuffled so completed/started
// homes are spatially interspersed rather than clustered.
const stagePool = [];
for (const [key, n] of Object.entries(STAGE_COUNTS)) {
  for (let i = 0; i < n; i++) stagePool.push(key);
}
// Fisher–Yates with the seeded PRNG.
for (let i = stagePool.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [stagePool[i], stagePool[j]] = [stagePool[j], stagePool[i]];
}

// Allocate lot counts per neighborhood from weights (largest-remainder).
const rawAlloc = NEIGHBORHOODS.map((nb) => nb.weight * TOTAL);
const alloc = rawAlloc.map(Math.floor);
let allocated = alloc.reduce((a, b) => a + b, 0);
const remainders = rawAlloc
  .map((v, i) => ({ i, frac: v - Math.floor(v) }))
  .sort((a, b) => b.frac - a.frac);
let ri = 0;
while (allocated < TOTAL) {
  alloc[remainders[ri % remainders.length].i]++;
  allocated++;
  ri++;
}

const features = [];
const byNeighborhood = {};
let poolIdx = 0;
let idCounter = 1;

NEIGHBORHOODS.forEach((nb, ni) => {
  const count = alloc[ni];
  const streets = buildStreets(nb);
  const mPerDegLat = 111320;
  const lat0 = (nb.box[1] + nb.box[3]) / 2;
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);

  const perStreet = Math.ceil(count / streets.length);
  const nbCounts = { submitted: 0, issued: 0, construction: 0, completed: 0 };

  let placed = 0;
  for (let s = 0; s < streets.length && placed < count; s++) {
    const street = streets[s];
    for (let k = 0; k < perStreet && placed < count; k++) {
      const t = perStreet === 1 ? 0.5 : k / (perStreet - 1 || 1); // position along street
      const side = k % 2 === 0 ? 1 : -1; // alternate sides of the street
      const perpM = side * randRange(8, 16);
      const perpAngle = (nb.angle + 90) * (Math.PI / 180);
      let lon =
        street.startLon +
        (street.endLon - street.startLon) * t +
        (Math.cos(perpAngle) * perpM) / mPerDegLon;
      let lat =
        street.startLat +
        (street.endLat - street.startLat) * t +
        (Math.sin(perpAngle) * perpM) / mPerDegLat;
      // small extra jitter, then clamp inside the box
      lon += randRange(-0.00012, 0.00012);
      lat += randRange(-0.00012, 0.00012);
      [lon, lat] = clamp(lon, lat, nb.box);

      const stageKey = stagePool[poolIdx++];
      const st = STATUS[stageKey];
      nbCounts[stageKey]++;

      // Strictly increasing along the street; even numbers one side, odd the
      // other — avoids duplicate addresses while staying block-realistic.
      const houseNumber = street.baseNumber + k * 4 + (side < 0 ? 1 : 0);
      const address = `${houseNumber} ${street.name.replace(/-/g, " ")}`;
      const tl = makeTimeline(stageKey);

      const props = {
        id: idCounter++,
        address,
        neighborhood: nb.name,
        status: stageKey,
        statusLabel: st.label,
        permitType: "Bldg-New",
        submittedDate: tl.submitted ? iso(tl.submitted) : null,
        issuedDate: tl.issued ? iso(tl.issued) : null,
        startDate: tl.start ? iso(tl.start) : null,
        completedDate: tl.completed ? iso(tl.completed) : null,
        estCompletionDate: tl.est ? iso(tl.est) : null,
      };

      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(lon.toFixed(6)), Number(lat.toFixed(6))] },
        properties: props,
      });
      placed++;
    }
  }
  byNeighborhood[nb.name] = { total: count, ...nbCounts };
});

/* ------------------------------- output --------------------------------- */
const geojson = { type: "FeatureCollection", features };

// Cumulative funnel (what the dashboard headline shows).
const funnel = {
  submitted: STAGE_COUNTS.submitted + STAGE_COUNTS.issued + STAGE_COUNTS.construction + STAGE_COUNTS.completed,
  issued: STAGE_COUNTS.issued + STAGE_COUNTS.construction + STAGE_COUNTS.completed,
  construction: STAGE_COUNTS.construction + STAGE_COUNTS.completed,
  completed: STAGE_COUNTS.completed,
};

const stats = {
  lastUpdated: iso(LAST_UPDATED),
  fireDate: iso(FIRE_DATE),
  permitType: "Bldg-New",
  totalLots: TOTAL,
  funnel, // cumulative: 1628 / 1088 / 905 / 27
  currentStage: STAGE_COUNTS, // 540 / 183 / 878 / 27
  statuses: Object.values(STATUS),
  byNeighborhood,
  timeline: {
    start: iso(FIRE_DATE),
    end: iso(LAST_UPDATED),
    days: daysBetween(FIRE_DATE, LAST_UPDATED),
  },
};

mkdirSync(resolve(ROOT, "data"), { recursive: true });
writeFileSync(resolve(ROOT, "data/homes.geojson"), JSON.stringify(geojson));
writeFileSync(resolve(ROOT, "data/stats.json"), JSON.stringify(stats, null, 2));

console.log(`Generated ${features.length} lots`);
console.log("Funnel (cumulative):", funnel);
console.log("Current stage:", STAGE_COUNTS);
console.log("Per neighborhood:");
for (const [n, v] of Object.entries(byNeighborhood)) {
  console.log(`  ${n.padEnd(22)} ${v.total}`);
}

#!/usr/bin/env node
/**
 * fetch-permits.mjs
 * -----------------
 * Real-data adapter. Pulls live new-construction ("Bldg-New") rebuild permits
 * for the Pacific Palisades burn area from a public ArcGIS FeatureServer and
 * writes them into the app's schema (data/homes.geojson + data/stats.json),
 * replacing the synthesized demo dataset produced by generate-data.mjs.
 *
 * WHY ArcGIS: the LA County Recovers permitting dashboards and the LA GeoHub
 * "Palisades Rebuild" layers are ArcGIS-hosted, queryable over a stable REST
 * API, and (unlike a flat permit CSV) return point geometry directly — so no
 * separate geocoding step is required.
 *
 *   Usage:
 *     node scripts/fetch-permits.mjs                 # fetch + write data files
 *     node scripts/fetch-permits.mjs --dry-run       # fetch + print summary only
 *     LAYER_URL="https://.../FeatureServer/0" node scripts/fetch-permits.mjs
 *
 * IMPORTANT — configure before first run:
 *   1. Set LAYER_URL below (or via env) to the real FeatureServer *layer*
 *      endpoint you want to track. Find it from:
 *        - LA County Recovers permitting dashboard  (recovery.lacounty.gov)
 *        - LA GeoHub Palisades rebuild layers        (geohub.lacity.org)
 *   2. Open the layer's `?f=json` metadata in a browser and confirm the field
 *      names in FIELDS below (they vary by layer). The script prints the field
 *      list it received if a mapping looks empty, to make this easy.
 *
 * This adapter is intentionally source-agnostic in shape: adjust FIELDS and
 * classifyStatus() and it will work against most permit layers. Requires
 * Node 18+ (uses the built-in global `fetch`).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

/* ----------------------------- configuration ---------------------------- */

// The ArcGIS FeatureServer *layer* endpoint (…/FeatureServer/<n>). REQUIRED.
const LAYER_URL = process.env.LAYER_URL || "";

// Attribute (column) names on the source layer -> our fields. Verify these
// against the layer's `?f=json` metadata; they differ from layer to layer.
const FIELDS = {
  address: process.env.F_ADDRESS || "PrimaryAddress",
  neighborhood: process.env.F_HOOD || "Neighborhood",
  permitType: process.env.F_PERMIT_TYPE || "PermitType",
  status: process.env.F_STATUS || "Status",
  submitted: process.env.F_SUBMITTED || "SubmittedDate",
  issued: process.env.F_ISSUED || "IssuedDate",
  started: process.env.F_STARTED || "ConstructionStartDate",
  completed: process.env.F_COMPLETED || "CofODate",
  estCompletion: process.env.F_EST || "EstCompletionDate",
};

// Only count ground-up rebuilds. Adjust to the source's vocabulary.
const NEW_CONSTRUCTION_VALUES = ["Bldg-New", "New", "1 or 2 Family Dwelling - New"];

// Server-side filter. Default keeps only new-construction permit types; widen
// or narrow to taste (e.g. add a ZIP or date clause).
const WHERE =
  process.env.WHERE ||
  `${FIELDS.permitType} IN (${NEW_CONSTRUCTION_VALUES.map((v) => `'${v.replace(/'/g, "''")}'`).join(",")})`;

const PAGE_SIZE = 1000;
const LAST_UPDATED = new Date().toISOString().slice(0, 10);

/* ------------------------------- helpers -------------------------------- */

// Normalize an epoch-ms / ISO / date string to YYYY-MM-DD (or null).
function toISO(v) {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Map a raw permit record to one of our four pipeline stages using whichever
// milestone dates are populated (most reliable), falling back to a status
// string. Order matters: check most-advanced first.
function classifyStatus(a) {
  if (toISO(a[FIELDS.completed])) return "completed";
  if (toISO(a[FIELDS.started])) return "construction";
  if (toISO(a[FIELDS.issued])) return "issued";
  if (toISO(a[FIELDS.submitted])) return "submitted";

  const s = String(a[FIELDS.status] || "").toLowerCase();
  if (/(c of o|certificate of occupancy|complete|final|co issued)/.test(s)) return "completed";
  if (/(construction|framing|under const|in progress|building)/.test(s)) return "construction";
  if (/(issued|approved|permit issued)/.test(s)) return "issued";
  if (/(submit|applied|plan check|review|intake)/.test(s)) return "submitted";
  return "submitted";
}

const STATUS_META = {
  submitted: { label: "Permit Submitted", color: "#8b5cf6", order: 1 },
  issued: { label: "Permit Issued", color: "#3b82f6", order: 2 },
  construction: { label: "Under Construction", color: "#f59e0b", order: 3 },
  completed: { label: "Completed (C of O)", color: "#22c55e", order: 4 },
};

async function fetchGeoJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/* -------------------------------- fetch --------------------------------- */

async function fetchAllFeatures() {
  const outFields = Object.values(FIELDS).join(",");
  let offset = 0;
  const all = [];
  let sampleFields = null;

  for (;;) {
    const q = new URLSearchParams({
      where: WHERE,
      outFields,
      f: "geojson",
      outSR: "4326",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
    });
    const gj = await fetchGeoJSON(`${LAYER_URL}/query?${q}`);
    const feats = gj.features || [];
    if (!sampleFields && feats[0]) sampleFields = Object.keys(feats[0].properties || {});
    all.push(...feats);
    if (feats.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return { features: all, sampleFields };
}

/* -------------------------------- build --------------------------------- */

function build(rawFeatures) {
  const features = [];
  const stageCounts = { submitted: 0, issued: 0, construction: 0, completed: 0 };
  const byNeighborhood = {};
  let id = 1;
  let minDate = null;

  for (const rf of rawFeatures) {
    const a = rf.properties || {};
    const geom = rf.geometry;
    if (!geom || geom.type !== "Point") continue; // need a mappable location

    const status = classifyStatus(a);
    stageCounts[status]++;

    const hood = a[FIELDS.neighborhood] || "Pacific Palisades";
    if (!byNeighborhood[hood]) {
      byNeighborhood[hood] = { total: 0, submitted: 0, issued: 0, construction: 0, completed: 0 };
    }
    byNeighborhood[hood].total++;
    byNeighborhood[hood][status]++;

    const submitted = toISO(a[FIELDS.submitted]);
    if (submitted && (!minDate || submitted < minDate)) minDate = submitted;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [Number(geom.coordinates[0].toFixed(6)), Number(geom.coordinates[1].toFixed(6))] },
      properties: {
        id: id++,
        address: String(a[FIELDS.address] || "Address unavailable"),
        neighborhood: hood,
        status,
        statusLabel: STATUS_META[status].label,
        permitType: String(a[FIELDS.permitType] || "Bldg-New"),
        submittedDate: submitted,
        issuedDate: toISO(a[FIELDS.issued]),
        startDate: toISO(a[FIELDS.started]),
        completedDate: toISO(a[FIELDS.completed]),
        estCompletionDate: toISO(a[FIELDS.estCompletion]),
      },
    });
  }

  const funnel = {
    submitted: stageCounts.submitted + stageCounts.issued + stageCounts.construction + stageCounts.completed,
    issued: stageCounts.issued + stageCounts.construction + stageCounts.completed,
    construction: stageCounts.construction + stageCounts.completed,
    completed: stageCounts.completed,
  };

  const stats = {
    lastUpdated: LAST_UPDATED,
    fireDate: "2025-01-07",
    permitType: "Bldg-New",
    totalLots: features.length,
    funnel,
    currentStage: stageCounts,
    statuses: Object.entries(STATUS_META).map(([key, m]) => ({ key, ...m })),
    byNeighborhood,
    timeline: { start: minDate || "2025-01-07", end: LAST_UPDATED },
    source: LAYER_URL,
  };

  return { geojson: { type: "FeatureCollection", features }, stats };
}

/* --------------------------------- main --------------------------------- */

async function main() {
  if (!LAYER_URL) {
    console.error(
      "✖ LAYER_URL is not set.\n" +
        "  Set the ArcGIS FeatureServer layer endpoint first, e.g.:\n" +
        '    LAYER_URL="https://services.arcgis.com/…/FeatureServer/0" node scripts/fetch-permits.mjs\n' +
        "  See the header of this file and README.md → “Wiring in real data”."
    );
    process.exit(1);
  }

  console.log(`Fetching permits from:\n  ${LAYER_URL}\n  where: ${WHERE}`);
  const { features: raw, sampleFields } = await fetchAllFeatures();
  console.log(`Received ${raw.length} raw features.`);

  const { geojson, stats } = build(raw);

  if (!geojson.features.length) {
    console.warn(
      "⚠ 0 mappable lots produced. The layer returned fields:\n  " +
        (sampleFields ? sampleFields.join(", ") : "(none)") +
        "\n  Update FIELDS in this script to match, then re-run."
    );
  }

  console.log("Funnel (cumulative):", stats.funnel);
  console.log("Current stage:", stats.currentStage);

  if (DRY_RUN) {
    console.log("\n(--dry-run) No files written.");
    return;
  }

  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  writeFileSync(resolve(ROOT, "data/homes.geojson"), JSON.stringify(geojson));
  writeFileSync(resolve(ROOT, "data/stats.json"), JSON.stringify(stats, null, 2));
  console.log(`\n✓ Wrote data/homes.geojson (${geojson.features.length} lots) and data/stats.json`);
}

main().catch((err) => {
  console.error("✖ Fetch failed:", err.message);
  process.exit(1);
});

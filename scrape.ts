// Pulls Craigslist + Zumper/PadMapper apartments near Morristown/Cranford, enriches with town, drive time, crime, scam flag,
// merges into docs/listings.json. Run: node scrape.ts  (Node 24 strips TS types natively, no build step)
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MAX_PRICE = 1700;
const MIN_PRICE = 600; // below this is almost always a scam or a parking spot
const MAX_DRIVE_MIN = 32; // to Morristown, traffic-free. ponytail: OSRM ignores traffic; 32 free-flow ≈ 40 real
const MAX_AGE_DAYS = 30;
const AVOID = ["Newark city", "Irvington township", "Elizabeth city"];
const WORK = { morristown: [-74.4815, 40.7968], cranford: [-74.3010, 40.6576] } as const;
// search centers: both workplaces plus a point west of Morristown where rents drop
const CENTERS = [WORK.morristown, WORK.cranford, [-74.58, 40.88]];
const OUT = "docs/listings.json";

type Listing = {
  id: string; source: string; url: string; title: string; price: number; beds: number | null; sqft: number | null;
  lat: number; lon: number; img: string | null; posted: string; firstSeen: string;
  town?: string; geoid?: string; driveM?: number; driveC?: number; violent?: number | null;
  room?: boolean; scam?: string[]; score?: number; parts?: Record<string, number>;
  // from the listing's own page
  detailed?: boolean; cats?: "yes" | "no" | null; income?: string | null; incomeMin?: number | null;
  credit?: number | null; landlord?: "private" | "complex" | null; textScam?: boolean;
};

const UA = { "User-Agent": "Mozilla/5.0 (apartment-search personal tool)" };

async function craigslist([lon, lat]: readonly number[]): Promise<Listing[]> {
  const q = new URLSearchParams({
    batch: "1-0-360-0-0", cc: "US", lang: "en", searchPath: "apa",
    lat: String(lat), lon: String(lon), search_distance: "20",
    min_price: String(MIN_PRICE), max_price: String(MAX_PRICE),
  });
  const res = await fetch(`https://sapi.craigslist.org/web/v8/postings/search/full?${q}`, { headers: UA });
  if (!res.ok) throw new Error(`craigslist ${res.status}`);
  const d = (await res.json()).data;
  const now = new Date().toISOString();
  // Item is a positional array; tagged sub-arrays: [4, images...], [5, beds, sqft], [6, slug]
  return d.items.map((it: any[]): Listing => {
    const tag = (n: number) => it.find(x => Array.isArray(x) && x[0] === n);
    const [locPart, lat, lon] = String(it[4]).split("~");
    const loc = d.decode.locations[+locPart.split(":")[0]];
    const id = String(d.decode.minPostingId + it[0]);
    const img = tag(4)?.[1]?.replace(/^\d+:/, "");
    const size = tag(5);
    return {
      id, source: "Craigslist",
      url: `https://${loc[1]}.craigslist.org/${loc[2] ? loc[2] + "/" : ""}apa/d/${tag(6)?.[1] ?? "x"}/${id}.html`,
      title: it.filter((x: unknown) => typeof x === "string").at(-1) ?? "",
      price: it[3], beds: size?.[1] ?? null, sqft: size?.[2] ?? null,
      lat: +lat, lon: +lon,
      img: img ? `https://images.craigslist.org/${img}_300x300.jpg` : null,
      posted: new Date((d.decode.minPostedDate + it[1]) * 1000).toISOString(),
      firstSeen: now,
    };
  });
}

// Zumper's site API (also feeds PadMapper). Map-box search, 100 per page.
const BOX = { min_lat: 40.55, max_lat: 41.05, min_lng: -74.95, max_lng: -74.15 };
async function zumper(): Promise<Listing[]> {
  const out: Listing[] = [];
  const now = new Date().toISOString();
  for (let offset = 0; offset < 1000; offset += 100) {
    const res = await fetch("https://www.zumper.com/api/t/1/pages/listables", {
      method: "POST", headers: { ...UA, "content-type": "application/json" },
      body: JSON.stringify({ ...BOX, min_price: MIN_PRICE, max_price: MAX_PRICE, limit: 100, offset, property_types: [-16, -17] }),
    });
    if (!res.ok) throw new Error(`zumper ${res.status}`);
    const page: any[] = (await res.json()).listables;
    for (const x of page) {
      if (!x.min_price) continue; // "call for price"
      out.push({
        id: `zu${x.listing_id}`, source: "Zumper", url: `https://www.zumper.com${x.url}`,
        title: x.title && !/^\d+BR\//.test(x.title) ? x.title : x.building_name || x.address || "",
        price: x.min_price, beds: x.min_bedrooms, sqft: null, lat: x.lat, lon: x.lng,
        img: x.image_ids[0] ? `https://img.zumpercdn.com/${x.image_ids[0]}/640x480` : null,
        posted: new Date(x.listed_on * 1000).toISOString(), firstSeen: now,
      });
    }
    if (page.length < 100) break;
  }
  return out;
}

async function town(l: Listing) {
  const q = `x=${l.lon}&y=${l.lat}&benchmark=Public_AR_Current&vintage=Current_Current&layers=County+Subdivisions&format=json`;
  const res = await fetch(`https://geocoding.geo.census.gov/geocoder/geographies/coordinates?${q}`);
  const g = res.ok && (await res.json()).result?.geographies?.["County Subdivisions"]?.[0];
  if (!res.ok) throw new Error(`census ${res.status}`);
  // "" = out of state; undefined = lookup failed, retry next run
  l.town = g?.STATE === "34" ? g.NAME : ""; l.geoid = g?.GEOID;
}

// OSRM demo server: one table call per 90 listings, minutes to each workplace
async function drive(ls: Listing[]) {
  for (let i = 0; i < ls.length; i += 90) {
    const chunk = ls.slice(i, i + 90);
    const coords = [...chunk.map(l => `${l.lon},${l.lat}`), WORK.morristown.join(","), WORK.cranford.join(",")].join(";");
    const n = chunk.length;
    const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=${[...Array(n).keys()].join(";")}&destinations=${n};${n + 1}`;
    const t = await (await fetch(url, { headers: UA })).json();
    if (t.code !== "Ok") throw new Error(`osrm ${t.code}`);
    chunk.forEach((l, j) => {
      l.driveM = Math.round(t.durations[j][0] / 60);
      l.driveC = Math.round(t.durations[j][1] / 60);
    });
  }
}

// Pulls income/credit requirements out of free text. Returns a short label for the card.
export function requirements(text: string, price: number) {
  let incomeMin: number | null = null, label: string | null = null, credit: number | null = null;
  const mult = text.match(/(?:income|earn|make|salary|gross)[^.]{0,50}?(\d+(?:\.\d+)?)\s*(?:x|times)\s*(?:the\s+)?(?:monthly\s+)?rent/i);
  const dollars = text.match(/income[^.]{0,40}?\$\s?(\d{2,3}),?(\d{3})/i);
  if (mult) {
    const n = +mult[1];
    incomeMin = Math.round(n >= 20 ? n * price : n * price * 12); // "40x" is yearly, "3x" is monthly
    label = `${n}x rent`;
  } else if (dollars && +(dollars[1] + dollars[2]) >= 20000) {
    incomeMin = +(dollars[1] + dollars[2]);
    label = "stated minimum";
  }
  const c = text.match(/(?:credit|fico)(?: score)?[^.\d]{0,25}(\d{3})|(\d{3})\+?\s*(?:minimum\s+)?(?:credit|fico)/i);
  const score = c && +(c[1] ?? c[2]);
  if (score && score >= 500 && score <= 850) credit = score;
  if (!label && !credit && /\b(income|pay ?stubs|employment) (verification|requirements?|check)|proof of income|credit check|background check\b/i.test(text))
    label = "income/credit check, no number given";
  return { incomeMin, income: label, credit };
}

// ponytail: keyword heuristic; good enough to nudge her toward flexible landlords
function landlordKind(text: string): "private" | "complex" | null {
  if (/leasing office|management (company|office)|apply online|our community|residents enjoy|amenities include|units available/i.test(text)) return "complex";
  if (/\b(owner|landlord|two[- ]family|2[- ]family|multi[- ]family home|our (house|home)|my (house|home))\b/i.test(text)) return "private";
  return null;
}

const SCAM_TEXT = /\b(wire|western union|money ?gram|gift cards?)\b|out of (the )?(country|state)|keys? (will be )?(mailed|shipped|sent)|deployed|missionary|god ?fearing|can(no|')t show/i;

async function details(l: Listing) {
  let text = "", cats: Listing["cats"] = null;
  if (l.source === "Zumper") {
    const d = await (await fetch(`https://www.zumper.com/api/t/1/listings/${l.id.slice(2)}`, { headers: UA })).json();
    text = d.description ?? "";
    // pets: null = not stated, [] = none allowed, 1 = cats (2/3 = dogs)
    cats = d.pets == null ? null : d.pets.includes(1) ? "yes" : "no";
  } else {
    const h = await (await fetch(l.url, { headers: UA })).text();
    const strip = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    text = strip(h.match(/<section id="postingbody">([\s\S]*?)<\/section>/)?.[1] ?? "").replace(/^QR Code Link to This Post/, "");
    if (/class="attr pets_cat"/.test(h)) cats = "yes";
  }
  if (/\bno (pets|cats|animals)\b|pets? (are )?not (allowed|permitted)/i.test(text)) cats = "no";
  else if (!cats && /\bcats? (ok|allowed|welcome|friendly)|pet[- ]friendly|pets (ok|allowed|welcome)/i.test(text)) cats = "yes";
  Object.assign(l, requirements(text, l.price), { cats, landlord: landlordKind(text), textScam: SCAM_TEXT.test(text), detailed: true });
}

const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function scamFlags(l: Listing, all: Listing[]): string[] {
  const flags: string[] = [];
  const peers = all.filter(o => o.beds === l.beds).map(o => o.price);
  if (peers.length >= 5 && l.price < 0.65 * median(peers)) flags.push("Price far below similar listings");
  // whole places here rarely go under ~$1,150 for a 1BR (+$500 per extra bedroom); far cheaper is the classic bait
  if (!l.room && l.price < 1150 + 500 * Math.max(0, (l.beds ?? 1) - 1)) flags.push("Unusually cheap for its size");
  // Zumper titles are building names, so units in one complex legitimately share a title
  if (l.source !== "Zumper" && all.some(o => o.id !== l.id && o.source !== "Zumper" && o.title === l.title && o.price !== l.price))
    flags.push("Same ad posted at different prices");
  if (!l.img) flags.push("No photos");
  if (l.textScam || SCAM_TEXT.test(l.title)) flags.push("Scam-style wording (wire money, owner away, keys mailed)");
  return flags;
}

// Each part is 0-1, higher is better. Ranges are the realistic spread of kept listings so scores don't bunch up.
// ponytail: hand-tuned weights, adjust after she's used it a week
export const WEIGHTS = { price: 0.3, drive: 0.3, safety: 0.2, cats: 0.1, terms: 0.1 };
const clamp = (x: number) => Math.min(1, Math.max(0, x));
export function score(l: Listing) {
  let terms = l.landlord === "private" ? 1 : l.landlord === "complex" ? 0.25 : 0.5; // how flexible on income/credit
  if (l.credit && l.credit >= 650) terms -= 0.25;
  if (l.incomeMin) terms -= 0.15;
  const parts = {
    price: clamp((MAX_PRICE - l.price) / 800), // $900 or less = full marks
    drive: clamp(1 - (l.driveM ?? MAX_DRIVE_MIN) / MAX_DRIVE_MIN),
    safety: l.violent == null ? 0.5 : clamp(1 - l.violent / 4), // state average is ~2
    cats: l.cats === "yes" ? 1 : l.cats === "no" ? 0 : 0.5,
    terms: clamp(terms),
  };
  const total = Object.entries(parts).reduce((s, [k, v]) => s + WEIGHTS[k as keyof typeof WEIGHTS] * v, 0);
  // cheapness and missing photos are weak signals on their own (and price already rewards cheap), so they cost less
  const soft = ["Unusually cheap for its size", "No photos"];
  const penalty = (l.scam ?? []).reduce((p, f) => p + (soft.includes(f) ? 0.05 : 0.15), 0);
  const pct = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(100 * v)]));
  return { score: Math.max(0, Math.round(100 * (total - penalty))), parts: pct };
}

async function main() {
  const crime = existsSync("data/crime.json") ? JSON.parse(readFileSync("data/crime.json", "utf8")) : {};
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { listings: [], rejected: [] };
  const old: Listing[] = prev.listings;
  // rejected = too far / wrong town; remembered so we don't re-geocode them every run
  const known = new Set([...old.map(l => l.id), ...prev.rejected]);

  const fresh = new Map<string, Listing>();
  // one source failing (blocked, API change) shouldn't sink the run
  const sources = [...CENTERS.map(c => () => craigslist(c)), zumper];
  for (const src of sources) {
    try { for (const l of await src()) fresh.set(l.id, l); }
    catch (e) { console.warn("source failed:", (e as Error).message); }
  }
  const added = [...fresh.values()].filter(l => !known.has(l.id));
  console.log(`fetched ${fresh.size}, new ${added.length}`);

  for (const l of added) await town(l).catch(e => console.warn("geocode", l.id, e.message));
  const notApt = /\b(shop|office|commercial|retail|parking|garage|storage|warehouse|store ?front)\b/i;
  const inNJ = added.filter(l => l.town && !AVOID.includes(l.town) && !notApt.test(l.title));
  await drive(inNJ);

  const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
  const keep = inNJ.filter(l => l.driveM! <= MAX_DRIVE_MIN);
  const all = [...old, ...keep]
    .filter(l => Date.parse(l.posted) > cutoff);
  // 4 at a time to stay polite; old listings without details get backfilled
  const todo = all.filter(l => !l.detailed);
  for (let i = 0; i < todo.length; i += 4)
    await Promise.all(todo.slice(i, i + 4).map(l => details(l).catch(e => console.warn("details", l.id, e.message))));
  const rejected = [...prev.rejected, ...added.filter(l => l.town !== undefined && !all.includes(l)).map(l => l.id)].slice(-5000);
  for (const l of all) {
    l.violent = crime[l.geoid!]?.violentPer1k ?? null;
    // 4+ bedrooms under $1,700 around here is a room in a shared house
    l.room = (l.beds ?? 0) >= 4 || /\b(room|shared|roommate|housemate)\b|in (a |an )?\d ?b(r|ed)/i.test(l.title);
    l.scam = scamFlags(l, all);
    Object.assign(l, score(l));
  }
  all.sort((a, b) => b.score! - a.score!);
  writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), listings: all, rejected }));
  console.log(`kept ${all.length} listings`);
}

if (import.meta.main) main().catch(e => { console.error(e); process.exit(1); });

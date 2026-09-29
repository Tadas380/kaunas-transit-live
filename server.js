// Kaunas Transit Live – server. No npm dependencies (Node.js 18+).
//  - loads the official Kaunas GTFS timetable at start-up and once a day
//  - fetches the live GPS feed from stops.lt (cached for a few seconds, so any
//    number of viewers causes at most one upstream request per interval)
//  - serves the map, the network (routes, stops, shapes), live vehicles and
//    arrival predictions per stop
// Start with:  node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { loadGtfs } = require("./lib/gtfs");
const live = require("./lib/live");
const { localParts } = require("./lib/time");

const PORT = process.env.PORT || 3000;
const GTFS_URL = process.env.GTFS_URL || "https://www.stops.lt/kaunas/kaunas/gtfs.zip";
const GPS_URL = process.env.GPS_URL || "https://www.stops.lt/kaunas/gps_full.txt";
const GTFS_FILE = process.env.GTFS_FILE || "";      // offline development: a local gtfs.zip
const GPS_FILE = process.env.GPS_FILE || "";        // offline development: a saved gps_full.txt
const FIXED_TIME = process.env.FIXED_TIME || "";    // offline development: pretend it's this ISO time
const LIVE_TTL_MS = 8_000;
const PUBLIC_DIR = path.join(__dirname, "public");

const now = () => (FIXED_TIME ? new Date(FIXED_TIME) : new Date());
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- timetable ----------
let gtfs = null, networkJson = null, gtfsLoadedAt = null;

async function fetchBuffer(url, timeoutMs = 30_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "kaunas-transit-live (github.com/Tadas380/kaunas-transit-live)" } });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function loadTimetable() {
  const buf = GTFS_FILE ? fs.readFileSync(GTFS_FILE) : await fetchBuffer(GTFS_URL, 60_000);
  const g = loadGtfs(buf);
  gtfs = g;
  gtfsLoadedAt = new Date();
  networkJson = zipped(JSON.stringify(buildNetwork(g)));
  lastLive = null;                                                  // re-match vehicles against the new timetable
  log(`timetable loaded: ${g.routes.size} routes, ${g.stops.size} stops, ${g.trips.size} trips in ${g.loadedMs} ms`);
}

// Routes, stops and simplified route lines for the map (sent once, gzip ~150 KB).
function buildNetwork(g) {
  const routes = [...g.routes.values()].sort((a, b) => a.type.localeCompare(b.type) || a.sort - b.sort).map(r => ({
    id: r.id, short: r.short, long: r.long, type: r.type, color: r.color, textColor: r.textColor, shapes: [...r.shapes],
  }));
  const stops = [...g.stops.values()].filter(s => s.routes.size).map(s => ({
    id: s.id, name: s.name, lat: s.lat, lon: s.lon,
    lines: [...s.routes].map(id => g.routes.get(id)).sort((a, b) => a.type.localeCompare(b.type) || a.sort - b.sort).map(r => r.short),
  }));
  const shapes = Object.fromEntries(g.shapePts);
  return { routes, stops, shapes, updated: new Date().toISOString() };
}

// ---------- live feed ----------
let lastLive = null, inflight = null;

async function getLive() {
  if (lastLive && Date.now() - lastLive.fetchedAt < LIVE_TTL_MS) return lastLive;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const text = GPS_FILE ? fs.readFileSync(GPS_FILE, "utf8") : (await fetchBuffer(GPS_URL, 10_000)).toString("utf8");
      const local = localParts(now());
      const serviceDays = gtfs ? gtfs.serviceDays(local) : [];
      const vehicles = live.parseGps(text);
      if (gtfs) live.matchTrips(vehicles, gtfs, serviceDays);
      lastLive = {
        fetchedAt: Date.now(), local, serviceDays, vehicles,
        json: zipped(JSON.stringify({
          updated: now().toISOString(), localSecs: local.secs,
          vehicles: vehicles.map(v => live.publicVehicle(v, gtfs)),
          stats: live.stats(vehicles, gtfs),
        })),
      };
      return lastLive;
    } catch (e) {
      log("live feed error:", e.message);
      if (lastLive) return lastLive;                                  // serve the last good data
      throw e;
    } finally { inflight = null; }
  })();
  return inflight;
}

// ---------- HTTP ----------
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
};

function zipped(str) { return { raw: Buffer.from(str), gz: zlib.gzipSync(str) }; }

function sendJson(req, res, status, body, maxAge = 0) {
  const payload = body.raw ? body : zipped(JSON.stringify(body));
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  res.writeHead(status, {
    ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store", Vary: "Accept-Encoding",
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
  });
  res.end(gzip ? payload.gz : payload.raw);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403, SECURITY_HEADERS); return res.end("Forbidden"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain" }); return res.end("Not found"); }
    const cache = /\/vendor\//.test(file) ? "public, max-age=604800" : "public, max-age=300";
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": cache });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { res.writeHead(400); return res.end(); }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, SECURITY_HEADERS); return res.end(); }

  try {
    if (url.pathname === "/api/network") {
      if (!networkJson) return sendJson(req, res, 503, { error: "The timetable is still loading. Try again in a few seconds." });
      return sendJson(req, res, 200, networkJson, 3600);
    }
    if (url.pathname === "/api/live") {
      const l = await getLive();
      return sendJson(req, res, 200, l.json);
    }
    const stopMatch = url.pathname.match(/^\/api\/stops\/([\w.-]{1,40})$/);
    if (stopMatch) {
      if (!gtfs) return sendJson(req, res, 503, { error: "The timetable is still loading." });
      const stop = gtfs.stops.get(stopMatch[1]);
      if (!stop) return sendJson(req, res, 404, { error: "Unknown stop." });
      const l = await getLive();
      const arrivals = live.arrivalsAt(stop.id, { gtfs, vehicles: l.vehicles, now: l.local.secs, serviceDays: l.serviceDays });
      return sendJson(req, res, 200, { stop: { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon }, localSecs: l.local.secs, arrivals });
    }
    if (url.pathname === "/api/health") {
      return sendJson(req, res, 200, { ok: true, timetable: gtfsLoadedAt, liveAgeSec: lastLive ? Math.round((Date.now() - lastLive.fetchedAt) / 1000) : null });
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    log("request error:", e.message);
    return sendJson(req, res, 502, { error: "Live data is temporarily unavailable. The map will retry automatically." });
  }
});

async function start() {
  server.listen(PORT, () => log(`Kaunas Transit Live running: http://localhost:${PORT}`));
  for (let attempt = 1; !gtfs; attempt++) {
    try { await loadTimetable(); }
    catch (e) { log(`timetable load failed (attempt ${attempt}): ${e.message}`); await new Promise(r => setTimeout(r, Math.min(60_000, attempt * 5_000))); }
  }
  // The feed is republished daily; refresh it once a day.
  setInterval(() => loadTimetable().catch(e => log("timetable refresh failed:", e.message)), 24 * 3600_000).unref();
}

if (require.main === module) start();

module.exports = { server, start, loadTimetable, getLive, buildNetwork };

// API tests: the server runs offline on the sample timetable and GPS snapshot.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.GTFS_FILE = path.join(__dirname, "fixtures", "gtfs-sample.zip");
process.env.GPS_FILE = path.join(__dirname, "fixtures", "gps-sample.txt");
process.env.FIXED_TIME = "2026-09-29T10:57:02Z";
const app = require("../server");

let base;
test.before(async () => {
  await app.loadTimetable();
  await new Promise(r => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => app.server.close());

test("GET /api/network returns routes, stops and route shapes (gzipped)", async () => {
  const r = await fetch(`${base}/api/network`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-encoding"), "gzip");
  const n = await r.json();
  assert.equal(n.routes.length, 2);
  assert.ok(n.stops.length > 50);
  assert.ok(n.stops.every(s => s.lines.length > 0));
  for (const route of n.routes) for (const id of route.shapes) assert.ok(n.shapes[id].length > 1, id);
});

test("GET /api/live returns matched vehicles and stats", async () => {
  const d = await (await fetch(`${base}/api/live`)).json();
  assert.equal(d.vehicles.length, 11);
  assert.ok(d.vehicles.every(v => v.matched));
  assert.equal(d.stats.vehicles, 11);
});

test("GET /api/stops/:id returns arrivals; unknown stops are 404", async () => {
  const n = await (await fetch(`${base}/api/network`)).json();
  const busy = n.stops.sort((a, b) => b.lines.length - a.lines.length)[0];
  const d = await (await fetch(`${base}/api/stops/${busy.id}`)).json();
  assert.equal(d.stop.id, busy.id);
  assert.ok(Array.isArray(d.arrivals));
  assert.equal((await fetch(`${base}/api/stops/does-not-exist`)).status, 404);
});

test("security headers and static file safety", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  for (const h of ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "strict-transport-security"])
    assert.ok(r.headers.get(h), h);
  assert.notEqual((await fetch(`${base}/..%2fserver.js`)).status, 200);
  assert.equal((await fetch(`${base}/api/live`, { method: "POST" })).status, 405);
  // app files are revalidated so a new deploy is picked up at once
  const js = await fetch(`${base}/app.js`);
  assert.equal(js.headers.get("cache-control"), "no-cache");
  assert.equal((await fetch(`${base}/app.js`, { headers: { "If-None-Match": js.headers.get("etag") } })).status, 304);
});

test("GET /api/stream pushes the live snapshot as Server-Sent Events", async () => {
  const ac = new AbortController();
  const r = await fetch(`${base}/api/stream`, { signal: ac.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/event-stream/);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  while (!/event: live\n[^]*?\n\n/.test(buf)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  assert.equal((await (await fetch(`${base}/api/health`)).json()).streamClients, 1, "the open stream stays registered");
  ac.abort();
  const data = JSON.parse(buf.match(/event: live\nid: \d+\ndata: (.*)\n\n/)[1]);
  assert.equal(data.vehicles.length, 11);
  assert.equal(data.stats.vehicles, 11);
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await (await fetch(`${base}/api/health`)).json()).streamClients, 0, "closed streams are cleaned up");
});

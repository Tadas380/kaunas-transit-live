// Tests on a real sample: trolleybus 2 and bus 3, cut from the official Kaunas
// timetable and a live GPS snapshot taken on Tue 29 Sep 2026 at 13:57.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadGtfs } = require("../lib/gtfs");
const live = require("../lib/live");
const { localParts } = require("../lib/time");

const FIX = path.join(__dirname, "fixtures");
const gtfs = loadGtfs(fs.readFileSync(path.join(FIX, "gtfs-sample.zip")));
const gpsText = fs.readFileSync(path.join(FIX, "gps-sample.txt"), "utf8");
const at = localParts(new Date("2026-09-29T10:57:02Z"));            // 13:57:02 in Kaunas
const days = gtfs.serviceDays(at);

test("gtfs: routes, stops, trips and indexes load", () => {
  assert.equal(gtfs.routes.size, 2);
  assert.equal(gtfs.routes.get("kaunas_trol_2").type, "trolleybus");
  assert.equal(gtfs.routes.get("kaunas_bus_3").type, "bus");
  const trip = gtfs.trips.get("T2-01-1-260901-ab-1344");
  assert.equal(trip.times[0], 13 * 3600 + 30 * 60, "arrives at the first stop at 13:30");
  assert.equal(trip.start, 13 * 3600 + 44 * 60, "but departs at 13:44, which is what the live feed uses");
  assert.ok(gtfs.stopsByNum.get("513"), "stops are indexed by their stops.lt number");
  assert.ok(gtfs.shapePts.size > 0);
});

test("gtfs: service calendar picks weekday vs weekend timetables", () => {
  const tue = gtfs.servicesOn("20260929", "tuesday"), sat = gtfs.servicesOn("20261003", "saturday");
  assert.ok(tue.has("246154") && !tue.has("246155"));
  assert.ok(sat.has("246155") && !sat.has("246154"));
});

test("live: parses the stops.lt feed and skips broken rows", () => {
  const vs = live.parseGps(gpsText);
  assert.equal(vs.length, 11);
  const t = vs.find(v => v.id === "T124");
  assert.equal(t.type, "trolleybus");
  assert.equal(t.line, "2");
  assert.equal(t.lat, 54.927085);
  assert.equal(t.lon, 23.929073);
  assert.equal(t.delay, 270);
  assert.equal(t.tripStart, 815 * 60);
});

test("live: every vehicle is matched to its timetable trip", () => {
  const vs = live.matchTrips(live.parseGps(gpsText), gtfs, days);
  assert.equal(vs.filter(v => v.trip).length, vs.length);
  const t = vs.find(v => v.id === "T124");
  assert.equal(t.trip.id, "T2-02-1-260901-ba-1335");
  assert.equal(gtfs.stops.get(t.trip.stops[t.nextIdx]).num, "513");
  // live ETA = timetable time at that stop + current delay (13:54:00 + 270 s)
  assert.equal(t.trip.times[t.nextIdx] + t.delay, t.nextEta);
});

test("live: start times a few minutes off still match (trip id time vs first departure)", () => {
  const row = "Transportas,Marsrutas,Grafikas,MasinosNumeris,Ilguma,Platuma,Greitis,Azimutas,ReisoPradziaMinutemis,NuokrypisSekundemis,SekanciosStotelesNum,AtvykimoLaikasSekundemis,KryptiesPavadinimas,\n";
  const trip = gtfs.trips.get("T2-01-1-260901-ab-1344");
  const stopNum = gtfs.stops.get(trip.stops[3]).num;
  const vs = live.matchTrips(live.parseGps(row + `Troleibusai,2,2-01,999,23920000,54910000,20,90,${13 * 60 + 45},30,${stopNum},${trip.times[3] + 30},Kauno pilis,\n`), gtfs, days);
  assert.equal(vs[0].trip.id, trip.id);
});

test("live: a vehicle waiting at the terminus is detected", () => {
  const trip = gtfs.trips.get("T2-01-1-260901-ab-1344");
  const last = trip.stops.length - 1;
  assert.equal(live.isLayover({ trip, nextIdx: last, timeOffset: 0, delay: 0, speed: 0, nextEta: trip.times[last] + 1800 }), true);
  assert.equal(live.isLayover({ trip, nextIdx: 5, timeOffset: 0, delay: 0, speed: 25, nextEta: trip.times[5] }), false);
});

test("live: arrivals combine GPS predictions and the timetable, soonest first", () => {
  const vs = live.matchTrips(live.parseGps(gpsText), gtfs, days);
  const t = vs.find(v => v.id === "T124");
  const stopId = t.trip.stops[t.nextIdx];
  const arr = live.arrivalsAt(stopId, { gtfs, vehicles: vs, now: at.secs, serviceDays: days });
  assert.ok(arr.length > 0);
  const mine = arr.find(a => a.vehicleId === "T124");
  assert.ok(mine && mine.live, "the approaching trolleybus is a live prediction");
  assert.equal(mine.eta, t.nextEta);
  for (let i = 1; i < arr.length; i++) assert.ok(arr[i].eta >= arr[i - 1].eta, "sorted by time");
  assert.ok(arr.every(a => a.eta >= at.secs - 30));
});

test("live: stats and the public vehicle shape", () => {
  const vs = live.matchTrips(live.parseGps(gpsText), gtfs, days);
  const s = live.stats(vs, gtfs);
  assert.equal(s.vehicles, 11);
  assert.equal(s.buses + s.trolleybuses, 11);
  assert.ok(s.onTimeShare >= 0 && s.onTimeShare <= 100);
  const p = live.publicVehicle(vs.find(v => v.id === "T124"), gtfs);
  assert.deepEqual(Object.keys(p).sort(), ["bearing", "color", "delay", "headsign", "id", "lat", "layover", "line", "lon", "matched", "nextEta", "nextStop", "routeId", "shapeId", "speed", "type"].sort());
  assert.equal(p.nextStop, "Ukmergės g. B");
  assert.ok(live.headsignMatches("Petrašiūnai(Klinikos)", "Petrašiūnai (Klinikos)"));
});

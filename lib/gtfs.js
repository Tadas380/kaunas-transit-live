// Loads a GTFS feed (the official Kaunas timetable) into compact in-memory indexes:
// routes, stops, trips with their stop sequences, route shapes and a
// stop → departures index used for arrival predictions.
const { readZip } = require("./zip");
const { parseCsv } = require("./csv");
const { hmsToSecs, previousDay } = require("./time");

function routeType(routeId, gtfsType) {
  if (/trol/i.test(routeId) || gtfsType === "11" || gtfsType === "800") return "trolleybus";
  return "bus";
}

// Douglas–Peucker simplification: keeps the shape of a route line with far fewer points.
function simplify(points, tolerance = 0.00004) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > tolerance * tolerance) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

function loadGtfs(zipBuffer) {
  const zip = readZip(zipBuffer);
  const text = name => zip.read(name).toString("utf8");
  const started = Date.now();

  // ---- routes ----
  const routes = new Map();
  parseCsv(text("routes.txt"), r => {
    routes.set(r.route_id, {
      id: r.route_id, short: r.route_short_name, long: r.route_long_name,
      type: routeType(r.route_id, r.route_type),
      color: `#${(r.route_color || "DC3131").toUpperCase()}`, textColor: `#${(r.route_text_color || "FFFFFF").toUpperCase()}`,
      sort: Number(r.route_sort_order) || 0, shapes: new Set(),
    });
  });

  // ---- stops ----  (the live feed refers to stops by the number in stop_url)
  const stops = new Map(), stopsByNum = new Map();
  parseCsv(text("stops.txt"), s => {
    if (s.location_type && s.location_type !== "0") return;
    const num = (s.stop_url.match(/stop\/(\d+)/) || [])[1] || s.stop_code || null;
    const stop = { id: s.stop_id, num, name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon, routes: new Set() };
    stops.set(s.stop_id, stop);
    if (num) { if (!stopsByNum.has(num)) stopsByNum.set(num, []); stopsByNum.get(num).push(s.stop_id); }
  });

  // ---- service calendar ----
  const calendar = new Map(), exceptions = new Map();
  if (zip.has("calendar.txt")) parseCsv(text("calendar.txt"), c => calendar.set(c.service_id, c));
  if (zip.has("calendar_dates.txt")) parseCsv(text("calendar_dates.txt"), c => {
    if (!exceptions.has(c.service_id)) exceptions.set(c.service_id, new Map());
    exceptions.get(c.service_id).set(c.date, c.exception_type);
  });

  // ---- trips ----
  const trips = new Map();
  parseCsv(text("trips.txt"), t => {
    trips.set(t.trip_id, { id: t.trip_id, routeId: t.route_id, serviceId: t.service_id, headsign: t.trip_headsign,
      dir: t.direction_id, shapeId: t.shape_id, stops: [], times: [], deps: [] });
    const route = routes.get(t.route_id);
    if (route && t.shape_id) route.shapes.add(t.shape_id);
  });

  // ---- stop times (the big one) ----
  const rows = [];
  parseCsv(text("stop_times.txt"), st => {
    const arr = hmsToSecs(st.arrival_time || st.departure_time), dep = hmsToSecs(st.departure_time || st.arrival_time);
    rows.push([st.trip_id, +st.stop_sequence, st.stop_id, arr, dep]);
  });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  for (const [tripId, , stopId, arr, dep] of rows) {
    const trip = trips.get(tripId);
    if (!trip) continue;
    trip.stops.push(stopId); trip.times.push(arr); trip.deps.push(dep);
  }

  // indexes: trips by (route, first departure) for matching live vehicles; departures per stop
  const tripsByStart = new Map(), departuresByStop = new Map();
  for (const trip of trips.values()) {
    if (!trip.stops.length) continue;
    trip.start = trip.deps[0];            // the live feed counts a trip from its first departure…
    const m = trip.id.match(/-(\d{2})(\d{2})$/);  // …or from the time in the trip id (A3-11-1-260903-ab-1243)
    trip.nominalStart = m ? +m[1] * 3600 + +m[2] * 60 : trip.start;
    for (const t of new Set([trip.start, trip.nominalStart])) {
      const key = `${trip.routeId}|${Math.round(t / 60)}`;       // indexed by minute
      if (!tripsByStart.has(key)) tripsByStart.set(key, []);
      tripsByStart.get(key).push(trip);
    }
    const route = routes.get(trip.routeId);
    trip.stops.forEach((stopId, i) => {
      const stop = stops.get(stopId);
      if (stop && route) stop.routes.add(route.id);
      if (i === trip.stops.length - 1) return;               // nobody boards at the last stop
      if (!departuresByStop.has(stopId)) departuresByStop.set(stopId, []);
      departuresByStop.get(stopId).push([trip.deps[i], trip]);
    });
  }
  for (const list of departuresByStop.values()) list.sort((a, b) => a[0] - b[0]);

  // ---- shapes, simplified ----
  const shapePts = new Map();
  if (zip.has("shapes.txt")) {
    const raw = new Map();
    parseCsv(text("shapes.txt"), s => {
      if (!raw.has(s.shape_id)) raw.set(s.shape_id, []);
      raw.get(s.shape_id).push([+s.shape_pt_sequence, +s.shape_pt_lat, +s.shape_pt_lon]);
    });
    for (const [id, pts] of raw) {
      pts.sort((a, b) => a[0] - b[0]);
      shapePts.set(id, simplify(pts.map(p => [p[1], p[2]])).map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]));
    }
  }

  // ---- which services run on a given day ----
  function servicesOn(ymd, weekday) {
    const active = new Set();
    for (const [id, c] of calendar) if (c[weekday] === "1" && c.start_date <= ymd && ymd <= c.end_date) active.add(id);
    for (const [id, ex] of exceptions) {
      const type = ex.get(ymd);
      if (type === "1") active.add(id);
      if (type === "2") active.delete(id);
    }
    return active;
  }

  // Services for "today" plus yesterday's after-midnight trips, with a time offset.
  function serviceDays(local) {
    const y = previousDay(local.ymd);
    return [{ services: servicesOn(local.ymd, local.weekday), offset: 0 }, { services: servicesOn(y.ymd, y.weekday), offset: 86400 }];
  }

  return {
    routes, stops, stopsByNum, trips, tripsByStart, departuresByStop, shapePts, servicesOn, serviceDays,
    loadedMs: Date.now() - started, stopTimeRows: rows.length,
  };
}

module.exports = { loadGtfs, simplify };

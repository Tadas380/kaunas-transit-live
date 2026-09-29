// Live vehicle feed: parsing, matching each vehicle to its timetable trip,
// arrival predictions for any stop, and network statistics.
const { csvToArray } = require("./csv");

const TYPE = { autobusai: "bus", troleibusai: "trolleybus" };
const ON_TIME_EARLY = -60, ON_TIME_LATE = 180;   // seconds; what counts as "on time"
const MATCH_WINDOW_MIN = 3;                        // live and timetable start times can differ by a few minutes

// "Petrašiūnai(Klinikos)" vs "Petrašiūnai (Klinikos)": compare letters only.
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
function headsignMatches(a, b) {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.startsWith(y.slice(0, 8)) || y.startsWith(x.slice(0, 8)));
}

// stops.lt gps_full.txt → vehicle objects. Coordinates are stored as integers (degrees × 1e6).
function parseGps(text) {
  const out = [];
  for (const r of csvToArray(text)) {
    const type = TYPE[String(r.Transportas || "").toLowerCase()];
    const lat = Number(r.Platuma) / 1e6, lon = Number(r.Ilguma) / 1e6;
    if (!type || !r.Marsrutas || !lat || !lon || lat < 54 || lat > 56 || lon < 22 || lon > 26) continue;
    const num = v => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
    out.push({
      id: `${type === "bus" ? "B" : "T"}${r.MasinosNumeris}`,
      type, line: r.Marsrutas.trim(), routeId: `kaunas_${type === "bus" ? "bus" : "trol"}_${r.Marsrutas.trim()}`,
      block: r.Grafikas, vehicleNo: r.MasinosNumeris,
      lat, lon, speed: num(r.Greitis) || 0, bearing: num(r.Azimutas),
      tripStart: num(r.ReisoPradziaMinutemis) == null ? null : num(r.ReisoPradziaMinutemis) * 60,
      delay: num(r.NuokrypisSekundemis), nextStopNum: r.SekanciosStotelesNum || null,
      nextEta: num(r.AtvykimoLaikasSekundemis), headsign: (r.KryptiesPavadinimas || "").trim(),
    });
  }
  return out;
}

// Where on the trip the vehicle is heading. Loop routes visit some stops twice, so
// pick the occurrence whose timetable time (+ current delay) best fits the live ETA.
function nextStopIndex(trip, nextIds, v, offset) {
  let best = -1, bestErr = Infinity;
  for (let i = 0; i < trip.stops.length; i++) {
    if (!nextIds.has(trip.stops[i])) continue;
    if (v.nextEta == null) return i;
    const err = Math.abs(trip.times[i] - offset + (v.delay || 0) - v.nextEta);
    if (err < bestErr) { best = i; bestErr = err; }
  }
  return best;
}

// A vehicle waiting at the end of its line still reports the trip it just finished,
// while its ETA already points at the next departure. Those shouldn't drive predictions.
function isLayover(v) {
  if (!v.trip || v.nextIdx < 0 || v.nextEta == null || v.speed > 3) return false;
  const planned = v.trip.times[v.nextIdx] - v.timeOffset + (v.delay || 0);
  const atEnd = v.nextIdx === 0 || v.nextIdx >= v.trip.stops.length - 2;
  return atEnd && Math.abs(v.nextEta - planned) > 300;
}

// Finds the timetable trip each vehicle is running: same route, same start time,
// running today (or yesterday after midnight), and its next stop is on that trip.
function matchTrips(vehicles, gtfs, serviceDays) {
  for (const v of vehicles) {
    v.trip = null; v.nextIdx = -1;
    if (v.tripStart == null) continue;
    const nextIds = new Set(v.nextStopNum ? gtfs.stopsByNum.get(v.nextStopNum) || [] : []);
    let best = null, bestScore = -Infinity;
    const seen = new Set();
    for (const day of serviceDays) {
      const minute = Math.round((v.tripStart + day.offset) / 60);
      for (let m = minute - MATCH_WINDOW_MIN; m <= minute + MATCH_WINDOW_MIN; m++) {
        for (const trip of gtfs.tripsByStart.get(`${v.routeId}|${m}`) || []) {
          if (seen.has(trip.id) || !day.services.has(trip.serviceId)) continue;
          seen.add(trip.id);
          const idx = nextStopIndex(trip, nextIds, v, day.offset);
          const drift = Math.min(Math.abs(trip.start - day.offset - v.tripStart), Math.abs(trip.nominalStart - day.offset - v.tripStart));
          const score = (idx >= 0 ? 100 : 0)                       // its next stop is on this trip
            + (headsignMatches(trip.headsign, v.headsign) ? 50 : 0) // same destination
            - drift / 60;                                           // closest start time
          if (score > bestScore) { best = { trip, idx, offset: day.offset }; bestScore = score; }
        }
      }
    }
    if (best) { v.trip = best.trip; v.nextIdx = best.idx; v.timeOffset = best.offset; }
    v.layover = isLayover(v);
  }
  return vehicles;
}

// Upcoming arrivals at a stop: live predictions from vehicles on the way (timetable
// time + the vehicle's current delay), then timetable departures of trips that
// haven't started yet.
function arrivalsAt(stopId, { gtfs, vehicles, now, serviceDays, horizon = 3600, limit = 12 }) {
  const out = [];
  const servedTrips = new Set();
  for (const v of vehicles) {
    if (!v.trip || v.nextIdx < 0 || v.layover) continue;
    servedTrips.add(v.trip.id);
    const { stops, times } = v.trip;
    for (let i = v.nextIdx; i < stops.length - 1; i++) {
      if (stops[i] !== stopId) continue;
      const eta = i === v.nextIdx && v.nextEta != null ? v.nextEta : times[i] - v.timeOffset + (v.delay || 0);
      if (eta >= now - 30 && eta <= now + horizon) out.push(entry(v.trip, eta, true, v));
    }
  }
  const deps = gtfs.departuresByStop.get(stopId) || [];
  for (const day of serviceDays) {
    for (const [t, trip] of deps) {
      const eta = t - day.offset;
      if (eta < now || eta > now + horizon) continue;
      if (servedTrips.has(trip.id) || !day.services.has(trip.serviceId)) continue;
      if (trip.start - day.offset <= now - 60) continue;     // already started but no GPS: unknown, skip
      out.push(entry(trip, eta, false, null));
    }
  }
  out.sort((a, b) => a.eta - b.eta);
  return out.slice(0, limit);

  function entry(trip, eta, live, v) {
    const r = gtfs.routes.get(trip.routeId) || {};
    return { line: r.short, routeId: trip.routeId, type: r.type, color: r.color, headsign: trip.headsign, eta: Math.round(eta),
      minutes: Math.max(0, Math.round((eta - now) / 60)), live, delay: v ? v.delay : null, vehicleId: v ? v.id : null };
  }
}

// Network summary for the side panel.
function stats(vehicles, gtfs) {
  const withDelay = vehicles.filter(v => !v.layover && v.delay != null && Math.abs(v.delay) < 3600);
  const onTime = withDelay.filter(v => v.delay >= ON_TIME_EARLY && v.delay <= ON_TIME_LATE).length;
  const late = withDelay.filter(v => v.delay > ON_TIME_LATE).length;
  const early = withDelay.filter(v => v.delay < ON_TIME_EARLY).length;
  const byLine = new Map();
  for (const v of withDelay) {
    if (!byLine.has(v.routeId)) byLine.set(v.routeId, []);
    byLine.get(v.routeId).push(v.delay);
  }
  const lines = [...byLine].map(([routeId, ds]) => {
    const r = gtfs && gtfs.routes.get(routeId) || {};
    return { routeId, line: r.short || routeId, type: r.type, color: r.color, vehicles: ds.length, avgDelay: Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) };
  });
  return {
    vehicles: vehicles.length,
    inService: vehicles.filter(v => !v.layover).length,
    buses: vehicles.filter(v => v.type === "bus").length,
    trolleybuses: vehicles.filter(v => v.type === "trolleybus").length,
    onTime, late, early,
    onTimeShare: withDelay.length ? Math.round((onTime / withDelay.length) * 100) : null,
    avgDelay: withDelay.length ? Math.round(withDelay.reduce((a, v) => a + v.delay, 0) / withDelay.length) : null,
    mostLateLines: lines.filter(l => l.vehicles >= 2).sort((a, b) => b.avgDelay - a.avgDelay).slice(0, 5),
    mostLateVehicles: [...withDelay].sort((a, b) => b.delay - a.delay).slice(0, 5).map(v => ({ id: v.id, line: v.line, type: v.type, delay: v.delay, headsign: v.headsign })),
  };
}

// Compact vehicle objects for the browser.
function publicVehicle(v, gtfs) {
  const r = gtfs && gtfs.routes.get(v.routeId);
  const nextStop = v.trip && v.nextIdx >= 0 ? gtfs.stops.get(v.trip.stops[v.nextIdx])
    : v.nextStopNum && gtfs ? gtfs.stops.get((gtfs.stopsByNum.get(v.nextStopNum) || [])[0]) : null;
  return {
    id: v.id, type: v.type, line: v.line, routeId: v.routeId, color: r ? r.color : v.type === "bus" ? "#DC3131" : "#0073AC",
    lat: v.lat, lon: v.lon, speed: v.speed, bearing: v.bearing, delay: v.delay,
    headsign: v.headsign || (v.trip && v.trip.headsign) || "", nextStop: nextStop ? nextStop.name : null, nextEta: v.nextEta,
    shapeId: v.trip ? v.trip.shapeId : null, matched: !!v.trip, layover: !!v.layover,
  };
}

module.exports = { isLayover, headsignMatches, parseGps, matchTrips, arrivalsAt, stats, publicVehicle, ON_TIME_EARLY, ON_TIME_LATE };

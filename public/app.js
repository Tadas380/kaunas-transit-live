// Kaunas Transit Live – front end (vanilla JS + Leaflet).
"use strict";

const KAUNAS = [54.8985, 23.9036];
const FALLBACK_MS = 5_000;         // polling interval only if the live stream can't connect
const STOP_REFRESH_MS = 10_000;
const STOPS_MIN_ZOOM = 15;

// ---------- small helpers ----------
const $ = s => document.querySelector(s);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}
const hm = secs => { const s = ((secs % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}`; };
function delayInfo(d) {
  if (d == null) return { text: "no data", cls: "" };
  if (d < -60) return { text: `${Math.round(-d / 60)} min early`, cls: "early" };
  if (d <= 180) return { text: d > 60 ? `+${Math.round(d / 60)} min` : "on time", cls: "ok" };
  return { text: `+${Math.round(d / 60)} min`, cls: d > 420 ? "very" : "late" };
}
const DELAY_COLOR = { ok: "#1FA971", late: "#E09200", very: "#E5484D", early: "#3C8DDB", "": "#5D6773" };
const badge = (line, color) => el("span", { class: "badge", style: `background:${color}` }, line);
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4000); }

// ---------- map ----------
const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 11, maxZoom: 18 }).setView(KAUNAS, 13);
L.control.zoom({ position: "topright" }).addTo(map);
// Standard OpenStreetMap tiles (free, attribution required), darkened with a CSS filter.
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, className: "dark-tiles",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const stopRenderer = L.canvas({ padding: 0.3 });
const stopLayer = L.layerGroup();
let selectedStopMarker = null;

// ---------- state ----------
const state = { network: null, routes: new Map(), stopsById: new Map(), live: null, selectedLine: null, selectedVehicle: null,
  selectedStop: null, colorBy: "line", markers: new Map(), lastUpdate: null, stopTimer: null };

// ---------- network (routes, stops, shapes) ----------
async function loadNetwork() {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch("/api/network").catch(() => null);
    if (r && r.ok) { state.network = await r.json(); break; }
    $("#updated").textContent = "Loading the timetable…";
    await new Promise(res => setTimeout(res, Math.min(10_000, 2000 + attempt * 1000)));
  }
  for (const r of state.network.routes) state.routes.set(r.id, r);
  for (const s of state.network.stops) {
    state.stopsById.set(s.id, s);
    L.circleMarker([s.lat, s.lon], { renderer: stopRenderer, radius: 4.5, color: "#E8EDF2", weight: 1.5, fillColor: "#151A21", fillOpacity: 1 })
      .bindTooltip(s.name, { className: "stop-tip", direction: "top", offset: [0, -4] })
      .on("click", () => openStop(s.id))
      .addTo(stopLayer);
  }
  renderLineChips();
  updateStopVisibility();
}
function updateStopVisibility() {
  if (map.getZoom() >= STOPS_MIN_ZOOM) stopLayer.addTo(map); else stopLayer.remove();
}
map.on("zoomend", updateStopVisibility);

function renderLineChips() {
  const box = $("#lines");
  box.replaceChildren(...state.network.routes.map(r =>
    el("button", { type: "button", class: "chip", "data-route": r.id, style: `background:${r.color}`, title: `${r.type === "bus" ? "Bus" : "Trolleybus"} ${r.short}: ${r.long}`,
      onclick: () => selectLine(state.selectedLine === r.id ? null : r.id) }, r.short)));
}

function drawRoute(routeId, shapeId) {
  routeLayer.clearLayers();
  const r = state.routes.get(routeId);
  if (!r) return null;
  const ids = shapeId ? [shapeId] : r.shapes;
  const lines = ids.map(id => state.network.shapes[id]).filter(Boolean);
  if (!lines.length) return null;
  L.polyline(lines, { color: "#000", weight: 9, opacity: .35, interactive: false }).addTo(routeLayer);
  const pl = L.polyline(lines, { color: r.color, weight: 5, opacity: .95, interactive: false }).addTo(routeLayer);
  return pl.getBounds();
}

function selectLine(routeId, { fit = true } = {}) {
  state.selectedLine = routeId;
  document.querySelectorAll(".chip").forEach(c => {
    c.classList.toggle("sel", c.dataset.route === routeId);
    c.classList.toggle("dim", !!routeId && c.dataset.route !== routeId);
  });
  const bounds = routeId ? drawRoute(routeId) : (routeLayer.clearLayers(), null);
  if (bounds && fit) map.flyToBounds(bounds, { duration: .6, ...fitPadding() });
  refreshMarkerStyles();
  setHash();
}
// Keep fitted routes clear of the side panel (desktop) or bottom sheet (phones).
function fitPadding() {
  const panel = $("#panel"), open = !panel.classList.contains("hidden");
  if (window.innerWidth > 700) return { paddingTopLeft: [open ? 410 : 40, 40], paddingBottomRight: [60, 40] };
  return { paddingTopLeft: [30, 30], paddingBottomRight: [30, (open ? panel.offsetHeight : 64) + 20] };
}

$("#line-search").addEventListener("input", e => {
  const q = e.target.value.trim().toUpperCase();
  const match = q ? state.network.routes.filter(r => r.short.toUpperCase() === q) : [];
  document.querySelectorAll(".chip").forEach(c => { c.style.display = !q || c.textContent.toUpperCase().startsWith(q) ? "" : "none"; });
  if (match.length === 1) selectLine(match[0].id);
  else if (!q && state.selectedLine) selectLine(null);
});

document.querySelectorAll("[data-colorby]").forEach(b => b.addEventListener("click", () => {
  state.colorBy = b.dataset.colorby;
  document.querySelectorAll("[data-colorby]").forEach(x => x.classList.toggle("on", x === b));
  refreshMarkerStyles();
}));

// ---------- live vehicles ----------
function vehicleColor(v) {
  if (v.layover) return "#5D6773";
  return state.colorBy === "delay" ? DELAY_COLOR[delayInfo(v.delay).cls] : v.color;
}
function makeIcon(v) {
  const rot = v.bearing == null || v.layover || v.speed < 1 ? "" : `<div class="arrow" style="transform:rotate(${v.bearing}deg)"></div>`;
  const cls = ["veh", v.layover ? "layover" : "", state.selectedLine && state.selectedLine !== v.routeId ? "faded" : "", state.selectedVehicle === v.id ? "sel" : ""].join(" ");
  return L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="${cls}">${rot}<div class="dot" style="background:${vehicleColor(v)}">${escapeHtml(v.line)}</div></div>` });
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const iconKey = v => [v.line, v.bearing, v.layover, v.speed < 1, vehicleColor(v), state.selectedLine, state.selectedVehicle === v.id].join("|");

function refreshMarkerStyles() {
  if (!state.live) return;
  for (const v of state.live.vehicles) {
    const m = state.markers.get(v.id);
    if (m) { m.marker.setIcon(makeIcon(v)); m.key = iconKey(v); m.marker.setZIndexOffset(state.selectedLine === v.routeId || state.selectedVehicle === v.id ? 1000 : 0); }
  }
}

// Live data normally arrives by push (/api/stream) the moment the city publishes it.
// refreshLive() is the polling fallback for networks that block event streams.
async function refreshLive() {
  try {
    const r = await fetch("/api/live", { cache: "no-store" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Live data unavailable");
    onLive(await r.json(), false);
  } catch (e) {
    $("#pulse").className = "pulse stale";
    $("#updated").textContent = "Live data paused, retrying…";
  }
}

// fresh = the stream pushed it, which only happens when the city feed changed.
function onLive(data, fresh = true) {
  if (state.live && data.updated < state.live.updated) return;          // ignore an older snapshot
  if (fresh || !state.live || data.updated !== state.live.updated) state.lastUpdate = Date.now();
  state.live = data;
  $("#pulse").className = "pulse live";
  if (state.network) applyVehicles(data.vehicles);
  renderStats(data.stats);
  if (state.selectedVehicle) renderVehicle();
}

function connectStream() {
  if (!window.EventSource) return;
  const es = new EventSource("/api/stream");
  es.addEventListener("live", e => { state.lastStream = Date.now(); try { onLive(JSON.parse(e.data)); } catch {} });
  es.addEventListener("ping", () => { state.lastStream = Date.now(); });
  es.onerror = () => {
    // The browser reconnects by itself; if the server refused the stream, retry later.
    if (es.readyState === EventSource.CLOSED) setTimeout(connectStream, 30_000);
  };
}

// ---------- vehicle motion ----------
// The feed is republished every ~5 s, but each vehicle only reports a new position
// every 5-17 s. In between, each vehicle keeps moving at its reported speed along its
// own route line (or straight ahead if it isn't on one). When a new position arrives:
//  - unchanged report: keep moving as before (don't snap back to the old position)
//  - vehicle is behind where we drew it: slow down until it catches up, never reverse
//  - vehicle is ahead: glide forward onto it
const MAX_AHEAD_S = 15, CATCH_UP_S = 8, STRAIGHT_AHEAD_S = 4, SETTLE_MS = 1500, M_PER_DEG = 111_320;
const shapeCache = new Map();

function shapeGeo(id) {
  if (shapeCache.has(id)) return shapeCache.get(id);
  const pts = state.network && state.network.shapes[id];
  let g = null;
  if (pts && pts.length > 1) {
    const kx = Math.cos(pts[0][0] * Math.PI / 180) * M_PER_DEG, cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot((pts[i][1] - pts[i - 1][1]) * kx, (pts[i][0] - pts[i - 1][0]) * M_PER_DEG));
    g = { pts, cum, kx };
  }
  shapeCache.set(id, g);
  return g;
}

// Distance along the route line of the point nearest to (lat, lon), preferring
// segments that point the way the vehicle is heading (loop routes pass roads twice).
function locateOnShape(g, lat, lon, bearing) {
  let best = null;
  for (let i = 1; i < g.pts.length; i++) {
    const [ay, ax] = g.pts[i - 1], [by, bx] = g.pts[i];
    const dx = (bx - ax) * g.kx, dy = (by - ay) * M_PER_DEG, px = (lon - ax) * g.kx, py = (lat - ay) * M_PER_DEG;
    const len2 = dx * dx + dy * dy, t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
    let d = Math.hypot(px - t * dx, py - t * dy);
    if (bearing != null) {
      const segBearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      if (Math.abs(((segBearing - bearing + 540) % 360) - 180) > 100) d += 60;   // wrong direction: penalise
    }
    if (!best || d < best.d) best = { d, s: g.cum[i - 1] + t * Math.sqrt(len2) };
  }
  return best && best.d < 40 ? best.s : null;
}

function pointAt(g, s) {
  let i = 1;
  while (i < g.cum.length - 1 && g.cum[i] < s) i++;
  const seg = g.cum[i] - g.cum[i - 1], t = seg ? Math.max(0, Math.min(1, (s - g.cum[i - 1]) / seg)) : 0;
  const [ay, ax] = g.pts[i - 1], [by, bx] = g.pts[i];
  return [ay + (by - ay) * t, ax + (bx - ax) * t];
}

// Where the model says the vehicle is at time `now` (ms), before smoothing.
function predicted(m, now) {
  const mo = m.motion, dt = Math.min((now - mo.t0) / 1000, MAX_AHEAD_S);
  if (!mo.mps) return [mo.lat, mo.lon];
  if (mo.geo) {
    let s = mo.s0 + mo.mps * dt;
    if (mo.hold != null) s = Math.max(s, mo.hold + mo.mps * mo.slow * dt);  // ahead of the report: creep on slowly
    return pointAt(mo.geo, Math.min(s, mo.geo.cum[mo.geo.cum.length - 1]));
  }
  const d = mo.mps * Math.min(dt, STRAIGHT_AHEAD_S), b = mo.bearing * Math.PI / 180;
  return [mo.lat + d * Math.cos(b) / M_PER_DEG, mo.lon + d * Math.sin(b) / (M_PER_DEG * Math.cos(mo.lat * Math.PI / 180))];
}

function setMotion(m, v, now) {
  const moving = !v.layover && v.speed >= 3 && !reducedMotion();
  const geo = moving && v.shapeId ? shapeGeo(v.shapeId) : null;
  const s0 = geo ? locateOnShape(geo, v.lat, v.lon, v.bearing) : null;
  m.motion = { lat: v.lat, lon: v.lon, t0: now, mps: moving && (s0 != null || v.bearing != null) ? v.speed / 3.6 : 0,
    bearing: v.bearing, geo: s0 != null ? geo : null, s0 };
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = k => (k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

function applyVehicles(vehicles) {
  const seen = new Set(), now = performance.now();
  for (const v of vehicles) {
    seen.add(v.id);
    let m = state.markers.get(v.id);
    if (!m) {
      const marker = L.marker([v.lat, v.lon], { icon: makeIcon(v), keyboard: false, title: `${v.type === "bus" ? "Bus" : "Trolleybus"} ${v.line} → ${v.headsign}` })
        .on("click", () => openVehicle(v.id)).addTo(map);
      m = { marker, key: iconKey(v), off: [0, 0], offT0: now };
      state.markers.set(v.id, m);
      setMotion(m, v, now);
      continue;
    }
    const key = iconKey(v);
    if (key !== m.key) { m.marker.setIcon(makeIcon(v)); m.key = key; }
    if (m.motion && m.motion.lat === v.lat && m.motion.lon === v.lon) continue;   // no new report for this vehicle
    const shown = m.marker.getLatLng(), prevGeo = m.motion && m.motion.geo;
    setMotion(m, v, now);
    const mo = m.motion;
    if (mo.geo && mo.geo === prevGeo) {
      const sShown = locateOnShape(mo.geo, shown.lat, shown.lng, null), ahead = sShown == null ? -1 : sShown - mo.s0;
      if (ahead > 0 && ahead < 250) {
        // Drawn ahead of the real position: continue from where it is, slower, until the real track catches up.
        mo.hold = sShown;
        mo.slow = Math.max(0.15, 1 - ahead / (mo.mps * CATCH_UP_S));
        m.off = [0, 0]; m.offT0 = now;
        const [hlat, hlon] = predicted(m, now);
        m.off = [shown.lat - hlat, shown.lng - hlon];                     // sub-metre projection difference only
        continue;
      }
    }
    // Glide from where the marker is now onto the new track (unless it jumped far, e.g. after a gap).
    const [plat, plon] = predicted(m, now), far = map.distance(shown, [plat, plon]) > 1500;
    m.off = far || reducedMotion() ? [0, 0] : [shown.lat - plat, shown.lng - plon];
    m.offT0 = now;
  }
  for (const [id, m] of state.markers) if (!seen.has(id)) { m.marker.remove(); state.markers.delete(id); }
  moveMarkers(now, true);
}

// Positions every marker for time `now`. Markers off-screen are skipped except on a full pass.
function moveMarkers(now, all = false) {
  const view = map.getBounds().pad(0.3);
  for (const m of state.markers.values()) {
    if (!m.motion) continue;
    const [lat, lon] = predicted(m, now), k = Math.min(1, (now - m.offT0) / SETTLE_MS), f = 1 - ease(k);
    const pos = [lat + m.off[0] * f, lon + m.off[1] * f];
    if (!all && !view.contains(pos) && !view.contains(m.marker.getLatLng())) continue;
    const cur = m.marker.getLatLng();
    if (cur.lat !== pos[0] || cur.lng !== pos[1]) m.marker.setLatLng(pos);
  }
}

let lastFrame = 0;
function frame(now) {
  if (now - lastFrame >= 33) { lastFrame = now; moveMarkers(now); }      // ~30 fps is plenty for map markers
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
map.on("moveend zoomend", () => moveMarkers(performance.now(), true));

function renderStats(s) {
  $("#s-vehicles").textContent = s.inService ?? s.vehicles;
  $("#s-split").textContent = `${s.buses} buses · ${s.trolleybuses} trolleybuses`;
  $("#s-ontime").textContent = s.onTimeShare == null ? "–" : `${s.onTimeShare}%`;
  $("#s-avg").textContent = s.avgDelay == null ? "–" : `${s.avgDelay < 0 ? "−" : "+"}${Math.floor(Math.abs(s.avgDelay) / 60)}:${String(Math.abs(s.avgDelay) % 60).padStart(2, "0")}`;
  $("#s-late").textContent = `${s.late} running over 3 min late`;

  const lv = $("#late-vehicles");
  lv.replaceChildren(...(s.mostLateVehicles.length ? s.mostLateVehicles : []).map(v => {
    const d = delayInfo(v.delay), veh = state.live.vehicles.find(x => x.id === v.id);
    return el("li", { onclick: () => openVehicle(v.id) }, badge(v.line, veh ? veh.color : "#555"),
      el("span", { class: "dest" }, "→ ", el("b", {}, v.headsign || "")), el("span", { class: `delay ${d.cls}` }, d.text));
  }));
  if (!s.mostLateVehicles.length) lv.replaceChildren(el("li", { class: "empty" }, "Nobody is late. Enjoy it while it lasts."));

  const ll = $("#late-lines");
  ll.replaceChildren(...s.mostLateLines.map(l => {
    const d = delayInfo(l.avgDelay);
    return el("li", { onclick: () => selectLine(l.routeId) }, badge(l.line, l.color),
      el("span", { class: "dest" }, `${l.vehicles} vehicles · average`), el("span", { class: `delay ${d.cls}` }, d.text));
  }));
}

setInterval(() => {
  // Stream silent (blocked by a proxy, or reconnecting): fall back to polling.
  if (!document.hidden && Date.now() - (state.lastStream || 0) > 12_000 && Date.now() - (state.lastPoll || 0) > FALLBACK_MS) {
    state.lastPoll = Date.now();
    refreshLive();
  }
  if (!state.lastUpdate) return;
  const s = Math.max(0, Math.round((Date.now() - state.lastUpdate) / 1000));
  if (!$("#pulse").classList.contains("stale")) $("#updated").textContent = s < 3 ? "Live · updated just now" : `Live · updated ${s} s ago`;
}, 1000);

// ---------- views ----------
function show(view) {
  for (const id of ["overview", "stop-view", "vehicle-view"]) $(`#${id}`).hidden = id !== view;
  $("#panel").classList.remove("hidden"); $("#reopen").hidden = true;
  $(".scroll").scrollTop = 0;
}
document.querySelectorAll("[data-back]").forEach(b => b.addEventListener("click", backToOverview));
function backToOverview() {
  clearInterval(state.stopTimer);
  state.selectedStop = null; state.selectedVehicle = null;
  if (selectedStopMarker) { selectedStopMarker.remove(); selectedStopMarker = null; }
  if (!state.selectedLine) routeLayer.clearLayers(); else drawRoute(state.selectedLine);
  refreshMarkerStyles();
  show("overview");
  setHash();
}

// Vehicle details
function openVehicle(id) {
  clearInterval(state.stopTimer); state.selectedStop = null;
  state.selectedVehicle = id;
  const v = state.live && state.live.vehicles.find(x => x.id === id);
  if (!v) return;
  drawRoute(v.routeId, v.shapeId);
  refreshMarkerStyles();
  map.flyTo([v.lat, v.lon], Math.max(map.getZoom(), 15), { duration: .6 });
  renderVehicle();
  show("vehicle-view");
}
function renderVehicle() {
  const v = state.live.vehicles.find(x => x.id === state.selectedVehicle);
  if (!v) { $("#veh-head").replaceChildren(el("p", {}, "This vehicle has left the live feed.")); $("#veh-facts").replaceChildren(); return; }
  const d = delayInfo(v.delay), type = v.type === "bus" ? "Bus" : "Trolleybus";
  $("#veh-head").replaceChildren(badge(v.line, v.color),
    el("div", {}, el("h3", {}, `→ ${v.headsign || "?"}`), el("p", {}, `${type} ${v.line} · vehicle no. ${v.id.slice(1)}`)));
  const facts = [
    ["Status", v.layover ? "Waiting at the terminus" : el("span", { class: `delay ${d.cls}` }, d.text === "on time" ? "On time" : d.cls === "early" ? d.text : `${d.text} late`)],
    ["Speed", `${v.speed} km/h`],
    ["Next stop", v.nextStop || "–"],
    ["Expected there", v.nextEta != null && !v.layover ? hm(v.nextEta) : "–"],
  ];
  $("#veh-facts").replaceChildren(...facts.flatMap(([k, val]) => [el("dt", {}, k), el("dd", {}, val)]));
}

// Stop arrivals
async function openStop(id) {
  const s = state.stopsById.get(id);
  if (!s) return;
  state.selectedVehicle = null; state.selectedStop = id;
  refreshMarkerStyles();
  if (!state.selectedLine) routeLayer.clearLayers();
  if (selectedStopMarker) selectedStopMarker.remove();
  selectedStopMarker = L.circleMarker([s.lat, s.lon], { radius: 9, color: "#FFB020", weight: 3, fillColor: "#151A21", fillOpacity: 1 }).addTo(map);
  if (map.getZoom() < STOPS_MIN_ZOOM || !map.getBounds().contains([s.lat, s.lon])) map.flyTo([s.lat, s.lon], 16, { duration: .6 });
  $("#stop-name").textContent = s.name;
  $("#stop-lines").replaceChildren(...s.lines.map(l => {
    const r = state.network.routes.find(x => x.short === l);
    return badge(l, r ? r.color : "#555");
  }));
  $("#arrivals").replaceChildren(el("li", { class: "empty" }, "Loading arrivals…"));
  show("stop-view");
  setHash();
  await loadArrivals();
  clearInterval(state.stopTimer);
  state.stopTimer = setInterval(loadArrivals, STOP_REFRESH_MS);
}
async function loadArrivals() {
  const id = state.selectedStop;
  if (!id) return;
  try {
    const r = await fetch(`/api/stops/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (state.selectedStop !== id) return;
    const list = $("#arrivals");
    if (!data.arrivals.length) return list.replaceChildren(el("li", { class: "empty" }, "No departures in the next hour."));
    list.replaceChildren(...data.arrivals.map(a => {
      const d = a.live ? delayInfo(a.delay) : null;
      const mins = a.minutes <= 0 ? el("span", { class: "now" }, "now") : `${a.minutes}`;
      return el("li", {},
        badge(a.line, a.color),
        el("div", { style: "min-width:0" }, el("div", { class: "hs" }, a.headsign),
          el("div", { class: "sub" }, a.live ? [el("span", { class: "livedot" }), "live · ", d.text] : [el("span", { class: "clock" }, "◷"), " timetable"])),
        el("div", { class: "when" }, mins, el("small", {}, a.minutes <= 0 ? hm(a.eta) : `min · ${hm(a.eta)}`)));
    }));
  } catch (e) {
    $("#arrivals").replaceChildren(el("li", { class: "empty" }, "Couldn't load arrivals. Retrying…"));
  }
}

// Nearest stop
$("#nearest").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Your browser can't share its location.");
  toast("Finding your location…");
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: la, longitude: lo } = pos.coords;
    let best = null, bestD = Infinity;
    for (const s of state.stopsById.values()) {
      const d = map.distance([la, lo], [s.lat, s.lon]);
      if (d < bestD) { best = s; bestD = d; }
    }
    if (!best || bestD > 3000) return toast("You're not near a Kaunas stop. Tap any stop on the map instead.");
    L.circleMarker([la, lo], { radius: 6, color: "#fff", weight: 2, fillColor: "#3C8DDB", fillOpacity: 1 }).addTo(map);
    openStop(best.id);
    toast(`Nearest stop: ${best.name} (${Math.round(bestD)} m)`);
  }, () => toast("Location access was declined."), { enableHighAccuracy: true, timeout: 10_000 });
});

// Panel collapse
$("#collapse").addEventListener("click", () => {
  const p = $("#panel");
  p.classList.toggle("hidden");
  $("#reopen").hidden = !p.classList.contains("hidden") || window.innerWidth <= 700;
});
$("#reopen").addEventListener("click", () => { $("#panel").classList.remove("hidden"); $("#reopen").hidden = true; });

// Shareable links: #line=37 or #stop=2860
function setHash() {
  const h = state.selectedStop ? `#stop=${state.selectedStop}` : state.selectedLine ? `#line=${state.routes.get(state.selectedLine)?.short}` : "";
  history.replaceState(null, "", h || location.pathname);
}
function applyHash() {
  const m = location.hash.match(/^#(line|stop)=([\w.-]+)$/);
  if (!m) return;
  if (m[1] === "stop") openStop(m[2]);
  else { const r = state.network.routes.find(x => x.short.toUpperCase() === m[2].toUpperCase()); if (r) selectLine(r.id); }
}

// ---------- start ----------
(async () => {
  $("#updated").textContent = "Loading the network…";
  refreshLive();
  await loadNetwork();
  await refreshLive();
  applyHash();
  state.lastStream = Date.now();
  connectStream();
})();

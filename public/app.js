// Kaunas Transit Live – front end (vanilla JS + Leaflet).
"use strict";

const KAUNAS = [54.8985, 23.9036];
const REFRESH_MS = 10_000;
const STOP_REFRESH_MS = 15_000;
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

async function refreshLive() {
  try {
    const r = await fetch("/api/live", { cache: "no-store" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Live data unavailable");
    const data = await r.json();
    state.live = data;
    state.lastUpdate = new Date(data.updated);
    $("#pulse").className = "pulse live";
    applyVehicles(data.vehicles);
    renderStats(data.stats);
    if (state.selectedVehicle) renderVehicle();
  } catch (e) {
    $("#pulse").className = "pulse stale";
    $("#updated").textContent = "Live data paused, retrying…";
  }
}

// Moves markers smoothly from their old to their new position.
function applyVehicles(vehicles) {
  const seen = new Set();
  const moves = [];
  for (const v of vehicles) {
    seen.add(v.id);
    const to = L.latLng(v.lat, v.lon);
    let m = state.markers.get(v.id);
    if (!m) {
      const marker = L.marker(to, { icon: makeIcon(v), keyboard: false, title: `${v.type === "bus" ? "Bus" : "Trolleybus"} ${v.line} → ${v.headsign}` })
        .on("click", () => openVehicle(v.id)).addTo(map);
      m = { marker, key: iconKey(v) };
      state.markers.set(v.id, m);
    } else {
      const key = iconKey(v);
      if (key !== m.key) { m.marker.setIcon(makeIcon(v)); m.key = key; }
      const from = m.marker.getLatLng();
      if (from.distanceTo(to) > 1500) m.marker.setLatLng(to);          // teleport after a long gap
      else if (!from.equals(to)) moves.push([m.marker, from, to]);
    }
  }
  for (const [id, m] of state.markers) if (!seen.has(id)) { m.marker.remove(); state.markers.delete(id); }
  if (!moves.length || matchMedia("(prefers-reduced-motion: reduce)").matches) return moves.forEach(([mk, , to]) => mk.setLatLng(to));
  const t0 = performance.now(), dur = 1800;
  const step = now => {
    const k = Math.min(1, (now - t0) / dur), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    for (const [mk, a, b] of moves) mk.setLatLng([a.lat + (b.lat - a.lat) * e, a.lng + (b.lng - a.lng) * e]);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

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
  if (!state.lastUpdate) return;
  const s = Math.max(0, Math.round((Date.now() - state.lastUpdate) / 1000));
  if (!$("#pulse").classList.contains("stale")) $("#updated").textContent = `Live · updated ${s < 5 ? "just now" : `${s} s ago`}`;
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
  setInterval(() => { if (!document.hidden) refreshLive(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLive(); });
})();

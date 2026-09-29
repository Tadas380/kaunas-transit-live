// Time helpers pinned to Kaunas local time (Europe/Vilnius), whatever timezone
// the server runs in. GTFS times are "seconds since local midnight".
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Vilnius", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "long", hourCycle: "h23",
});

function localParts(date = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return {
    ymd: `${p.year}${p.month}${p.day}`,
    weekday: p.weekday.toLowerCase(),
    secs: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

// The service day before `ymd` (needed for trips that run past midnight, e.g. 24:35:00).
function previousDay(ymd) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) - 1));
  return {
    ymd: d.toISOString().slice(0, 10).replace(/-/g, ""),
    weekday: DAYS[d.getUTCDay()],
  };
}

function hmsToSecs(s) {
  if (!s) return NaN;
  const [h, m, sec] = s.split(":").map(Number);
  return h * 3600 + m * 60 + (sec || 0);
}

function secsToHm(secs) {
  const s = ((secs % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

module.exports = { localParts, previousDay, hmsToSecs, secsToHm, DAYS };

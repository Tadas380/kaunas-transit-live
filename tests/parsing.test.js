// Unit tests for the low-level parsers. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { readZip } = require("../lib/zip");
const { parseCsv, csvToArray } = require("../lib/csv");
const { localParts, previousDay, hmsToSecs, secsToHm } = require("../lib/time");
const { simplify } = require("../lib/gtfs");

// Builds a tiny ZIP in memory (one stored + one deflated file) to test the reader.
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text, method] of files) {
    const raw = Buffer.from(text), data = method === 8 ? zlib.deflateRawSync(raw) : raw, n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test("zip: reads stored and deflated entries", () => {
  const zip = readZip(makeZip([["a.txt", "hello", 0], ["b.txt", "šiaurė ".repeat(200), 8]]));
  assert.deepEqual(zip.names(), ["a.txt", "b.txt"]);
  assert.equal(zip.read("a.txt").toString(), "hello");
  assert.equal(zip.read("b.txt").toString(), "šiaurė ".repeat(200));
  assert.throws(() => zip.read("missing.txt"), /missing/);
  assert.throws(() => readZip(Buffer.from("definitely not a zip file, just text")), /Not a ZIP/);
});

test("csv: quotes, escaped quotes, BOM, CRLF and empty fields", () => {
  const rows = csvToArray('﻿id,name,note\r\n1,"Kauno pilis","say ""labas"""\r\n2,"A, B",\r\n\r\n');
  assert.deepEqual(rows, [{ id: "1", name: "Kauno pilis", note: 'say "labas"' }, { id: "2", name: "A, B", note: "" }]);
  let n = 0;
  const header = parseCsv("x,y\n1,2\n3,4", () => n++);
  assert.deepEqual(header, ["x", "y"]);
  assert.equal(n, 2);
});

test("time: Kaunas local time in summer (UTC+3) and winter (UTC+2)", () => {
  assert.deepEqual(localParts(new Date("2026-09-29T10:57:02Z")), { ymd: "20260929", weekday: "tuesday", secs: 13 * 3600 + 57 * 60 + 2 });
  assert.equal(localParts(new Date("2026-12-15T10:00:00Z")).secs, 12 * 3600);
  assert.equal(localParts(new Date("2026-09-29T22:30:00Z")).ymd, "20260930");        // already tomorrow in Kaunas
  assert.deepEqual(previousDay("20260301"), { ymd: "20260228", weekday: "saturday" });
  assert.equal(hmsToSecs("24:35:00"), 88500);                                       // GTFS allows >24h
  assert.equal(secsToHm(88500), "00:35");
});

test("simplify keeps the ends and drops points on a straight line", () => {
  const line = Array.from({ length: 50 }, (_, i) => [54.9 + i * 0.0001, 23.9]);
  assert.deepEqual(simplify(line), [line[0], line[49]]);
  const corner = [[0, 0], [0, 0.01], [0.01, 0.01]];
  assert.equal(simplify(corner).length, 3);
});

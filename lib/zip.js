// Minimal ZIP reader (no dependencies). Reads the central directory at the end
// of the file, then inflates entries on demand with Node's built-in zlib.
// Supports "stored" (0) and "deflate" (8) entries, which is what GTFS feeds use.
const zlib = require("zlib");

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (end of central directory not found)");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt ZIP central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: () => [...entries.keys()],
    has: name => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`${name} is missing from the ZIP`);
      const lh = e.localOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error("Corrupt ZIP local header");
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + e.compressedSize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported compression method ${e.method} for ${name}`);
    },
  };
}

module.exports = { readZip };

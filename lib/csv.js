// Fast CSV parser for GTFS files: handles quoted fields, escaped quotes (""),
// CRLF line endings and a UTF-8 byte-order mark. Calls onRow(object) per row
// so large files (stop_times.txt is ~11 MB) never need a giant array of arrays.

function parseCsv(text, onRow) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let header = null;
  let field = "", row = [], inQuotes = false;
  const len = text.length;

  const endRow = () => {
    row.push(field); field = "";
    if (!header) header = row.map(h => h.trim());
    else if (!(row.length === 1 && row[0] === "")) {
      const obj = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = row[i] === undefined ? "" : row[i];
      onRow(obj);
    }
    row = [];
  };

  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (inQuotes) {
      if (c === 34) {                                   // "
        if (text.charCodeAt(i + 1) === 34) { field += '"'; i++; }
        else inQuotes = false;
      } else field += text[i];
    } else if (c === 34) inQuotes = true;
    else if (c === 44) { row.push(field); field = ""; }  // ,
    else if (c === 10) endRow();                         // \n
    else if (c !== 13) field += text[i];                 // skip \r
  }
  if (field !== "" || row.length) endRow();
  return header || [];
}

function csvToArray(text) {
  const rows = [];
  parseCsv(text, r => rows.push(r));
  return rows;
}

module.exports = { parseCsv, csvToArray };

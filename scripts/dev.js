// Offline demo mode: runs the app on the bundled sample (2 lines, real data from
// Tue 29 Sep 2026 13:57) without internet. Works on Windows, macOS and Linux.
const path = require("path");
process.env.GTFS_FILE = process.env.GTFS_FILE || path.join(__dirname, "..", "tests", "fixtures", "gtfs-sample.zip");
process.env.GPS_FILE = process.env.GPS_FILE || path.join(__dirname, "..", "tests", "fixtures", "gps-sample.txt");
process.env.FIXED_TIME = process.env.FIXED_TIME || "2026-09-29T10:57:02Z";
console.log("Offline demo mode: sample timetable + GPS snapshot (map tiles still need internet).");
require("../server.js").start();

// End-to-end: spawn the built server over stdio and call airbnb_listing_details for real.
import { spawn } from "node:child_process";

const CASES = [
  { id: "53610715", name: "Hilltop, Rhododendron OR", expect: "Central air conditioning" },
  { id: "1576852203737322823", name: "Secluded 5BR, Rhododendron OR", expect: null },
  { id: "1425762021690163826", name: "Cedar Creek Escape, Amboy WA", expect: null },
];

function call(id) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["dist/index.js", "--ignore-robots-txt"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let toolCallSent = false;
    const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 60000);

    const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");

    proc.stdout.on("data", (d) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        // The id-1 reply, not a fixed sleep, is what says the server is ready.
        if (msg.id === 1 && !toolCallSent) {
          toolCallSent = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
            name: "airbnb_listing_details", arguments: { id, ignoreRobotsText: true } } });
          continue;
        }

        if (msg.id === 2) {
          clearTimeout(timer);
          proc.kill();
          if (msg.error) {
            reject(new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`));
            return;
          }
          const text = msg.result?.content?.[0]?.text;
          if (!text) {
            reject(new Error(`malformed tools/call response: ${JSON.stringify(msg)}`));
            return;
          }
          resolve(JSON.parse(text));
        }
      }
    });
    proc.on("error", reject);

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  });
}

let failures = 0;
for (const c of CASES) {
  process.stdout.write(`\n=== ${c.name} (${c.id}) ===\n`);
  let out;
  try {
    out = await call(c.id);
  } catch (e) {
    console.log("  CALL FAILED:", e.message);
    failures++;
    continue;
  }
  if (out.error) { console.log("  ERROR:", out.error); failures++; continue; }

  const am = (out.details || []).find((d) => d.id === "AMENITIES_DEFAULT");
  if (!am || !am.seeAllAmenitiesGroups) {
    console.log("  FAIL: no amenities returned");
    failures++;
    continue;
  }
  // One object keyed by amenity category, each value a flattened string. Airbnb's
  // "Not included" group is just another category.
  const groups = am.seeAllAmenitiesGroups;
  const isCategoryMap =
    groups !== null && typeof groups === "object" && !Array.isArray(groups) &&
    Object.values(groups).every((x) => typeof x === "string");
  if (!isCategoryMap) {
    console.log(`  FAIL: seeAllAmenitiesGroups is not a category->string map, got ${Array.isArray(groups) ? "array" : typeof groups}`);
    failures++;
    continue;
  }
  console.log(`  categories: ${Object.keys(groups).join(", ")}`);

  const excluded = Object.entries(groups).filter(([k]) => /not included/i.test(k));
  console.log(`  unavailable: ${excluded.length ? excluded.map(([k, v]) => `${k} -> ${v}`).join(" ; ") : "none"}`);

  const heat = Object.entries(groups).find(([k]) => /heating and cooling/i.test(k));
  const ac = heat && /air conditioning|\bac\b|heat pump|mini.?split|ductless/i.exec(heat[1]);
  console.log("  A/C:", ac ? `available ("${ac[0]}")` : "not listed as available");

  // An amenity the listing lacks must never read as one it offers: anything under an
  // excluded category must not also appear under a normal one.
  const offered = Object.entries(groups)
    .filter(([k]) => !/not included/i.test(k))
    .map(([, v]) => v)
    .join(" | ");
  for (const [, items] of excluded) {
    for (const item of items.split(", ")) {
      if (item && offered.includes(item)) {
        console.log(`  FAIL: ${JSON.stringify(item)} is excluded but also listed as offered`);
        failures++;
      }
    }
  }
  if (c.expect && !offered.includes(c.expect)) {
    console.log(`  FAIL: expected to find ${JSON.stringify(c.expect)}`);
    failures++;
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall cases passed");
process.exit(failures ? 1 : 0);

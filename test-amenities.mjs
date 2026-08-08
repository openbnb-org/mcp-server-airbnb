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
    const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 60000);

    proc.stdout.on("data", (d) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          clearTimeout(timer);
          proc.kill();
          resolve(JSON.parse(msg.result.content[0].text));
        }
      }
    });
    proc.on("error", reject);

    const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "airbnb_listing_details", arguments: { id, ignoreRobotsText: true } } });
    }, 700);
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
  const groups = am.seeAllAmenitiesGroups;
  const nAvail = groups.reduce((n, g) => n + (g.available?.length || 0), 0);
  const nUnavail = groups.reduce((n, g) => n + (g.unavailable?.length || 0), 0);
  console.log(`  groups: ${groups.length}, available: ${nAvail}, UNAVAILABLE: ${nUnavail}`);

  const heat = groups.find((g) => /heating and cooling/i.test(g.title || ""));
  console.log("  Heating and cooling ->", JSON.stringify(heat?.available ?? []));

  const ac = (heat?.available || []).filter((t) => /air conditioning|ac\b|heat pump|mini.?split|ductless/i.test(t));
  console.log("  A/C VERDICT:", ac.length ? ac.join(" + ") : "none listed as available");

  if (nUnavail) {
    for (const g of groups.filter((g) => g.unavailable?.length)) {
      console.log(`  struck through [${g.title}]:`, g.unavailable.join(", "));
    }
  }
  if (c.expect && !JSON.stringify(groups).includes(c.expect)) {
    console.log(`  FAIL: expected to find ${JSON.stringify(c.expect)}`);
    failures++;
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall cases passed");
process.exit(failures ? 1 : 0);

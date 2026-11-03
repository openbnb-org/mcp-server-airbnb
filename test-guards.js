#!/usr/bin/env node

/**
 * Offline unit tests for guards.ts and util.ts (no network, no Airbnb).
 * Run after `npm run build`: node test-guards.js
 * DIST_DIR can point at another build output directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.env.DIST_DIR || join(here, "dist");

const guards = await import(pathToFileURL(join(dist, "guards.js")).href);
const util = await import(pathToFileURL(join(dist, "util.js")).href);

const {
  validateSearchParams,
  validateListingParams,
  ValidationError,
  Throttle,
  TtlCache,
} = guards;

// ---------- validateSearchParams ----------

test("search: minimal valid input gets defaults", () => {
  const p = validateSearchParams({ location: "  Paris, France " });
  assert.equal(p.location, "Paris, France");
  assert.equal(p.adults, 1);
  assert.equal(p.children, 0);
  assert.equal(p.infants, 0);
  assert.equal(p.pets, 0);
  assert.equal(p.ignoreRobotsText, false);
});

test("search: location is required and must be a string", () => {
  assert.throws(() => validateSearchParams({}), ValidationError);
  assert.throws(() => validateSearchParams({ location: "   " }), ValidationError);
  assert.throws(() => validateSearchParams({ location: 42 }), ValidationError);
  assert.throws(() => validateSearchParams({ location: "x".repeat(201) }), ValidationError);
  assert.throws(() => validateSearchParams(null), ValidationError);
});

test("search: dates must be real YYYY-MM-DD dates", () => {
  assert.throws(() => validateSearchParams({ location: "Rome", checkin: "03/11/2026" }), ValidationError);
  assert.throws(() => validateSearchParams({ location: "Rome", checkin: "2026-02-31" }), ValidationError);
  const p = validateSearchParams({ location: "Rome", checkin: "2026-12-20", checkout: "2026-12-27" });
  assert.equal(p.checkin, "2026-12-20");
  assert.equal(p.checkout, "2026-12-27");
});

test("search: checkout must follow checkin", () => {
  assert.throws(
    () => validateSearchParams({ location: "Rome", checkin: "2026-12-20", checkout: "2026-12-20" }),
    /after checkin/,
  );
  assert.throws(
    () => validateSearchParams({ location: "Rome", checkin: "2026-12-27", checkout: "2026-12-20" }),
    ValidationError,
  );
  assert.throws(() => validateSearchParams({ location: "Rome", checkout: "2026-12-20" }), /without checkin/);
});

test("search: guest counts are bounded integers, numeric strings accepted", () => {
  assert.equal(validateSearchParams({ location: "Rome", adults: "3" }).adults, 3);
  assert.throws(() => validateSearchParams({ location: "Rome", adults: -1 }), ValidationError);
  assert.throws(() => validateSearchParams({ location: "Rome", adults: 1.5 }), ValidationError);
  assert.throws(() => validateSearchParams({ location: "Rome", children: 51 }), ValidationError);
  assert.throws(() => validateSearchParams({ location: "Rome", pets: "abc" }), ValidationError);
});

test("search: price range", () => {
  const p = validateSearchParams({ location: "Rome", minPrice: 50, maxPrice: 200 });
  assert.equal(p.minPrice, 50);
  assert.equal(p.maxPrice, 200);
  assert.throws(() => validateSearchParams({ location: "Rome", minPrice: 300, maxPrice: 200 }), ValidationError);
  assert.throws(() => validateSearchParams({ location: "Rome", minPrice: -5 }), ValidationError);
  // 0 is a legitimate bound and must survive (not be treated as "missing").
  assert.equal(validateSearchParams({ location: "Rome", minPrice: 0 }).minPrice, 0);
});

test("search: propertyType must be one of the known values", () => {
  assert.equal(validateSearchParams({ location: "Rome", propertyType: "entire_home" }).propertyType, "entire_home");
  assert.throws(() => validateSearchParams({ location: "Rome", propertyType: "castle" }), ValidationError);
});

test("search: ignoreRobotsText only honoured for a real boolean true", () => {
  assert.equal(validateSearchParams({ location: "Rome", ignoreRobotsText: true }).ignoreRobotsText, true);
  assert.equal(validateSearchParams({ location: "Rome", ignoreRobotsText: "true" }).ignoreRobotsText, false);
});

// ---------- validateListingParams ----------

test("listing: id must be numeric (it lands in a URL path)", () => {
  assert.equal(validateListingParams({ id: "12345" }).id, "12345");
  assert.equal(validateListingParams({ id: 12345 }).id, "12345");
  assert.throws(() => validateListingParams({ id: "../admin" }), ValidationError);
  assert.throws(() => validateListingParams({ id: "12/34" }), ValidationError);
  assert.throws(() => validateListingParams({}), ValidationError);
});

test("listing: shares the date and guest rules", () => {
  assert.throws(
    () => validateListingParams({ id: "1", checkin: "2026-12-27", checkout: "2026-12-20" }),
    ValidationError,
  );
  assert.equal(validateListingParams({ id: "1", adults: 2 }).adults, 2);
});

// ---------- Throttle ----------

test("throttle: spaces consecutive calls and queues concurrent ones", async () => {
  let clock = 1000;
  const sleeps = [];
  const throttle = new Throttle(
    500,
    () => clock,
    async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  );
  await throttle.wait(); // first call goes straight through
  await throttle.wait(); // must wait the full interval
  await throttle.wait();
  assert.deepEqual(sleeps, [500, 500]);

  // Concurrent callers reserve consecutive slots instead of all firing together.
  sleeps.length = 0;
  clock = 10_000;
  const t2 = new Throttle(
    1000,
    () => clock,
    async (ms) => {
      sleeps.push(ms);
    },
  );
  await Promise.all([t2.wait(), t2.wait(), t2.wait()]);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("throttle: no wait once the interval has elapsed", async () => {
  let clock = 0;
  const sleeps = [];
  const throttle = new Throttle(
    100,
    () => clock,
    async (ms) => sleeps.push(ms),
  );
  await throttle.wait();
  clock = 5000;
  await throttle.wait();
  assert.deepEqual(sleeps, []);
});

// ---------- TtlCache ----------

test("cache: entries expire after the TTL", () => {
  let clock = 0;
  const cache = new TtlCache(1000, 10, () => clock);
  cache.set("a", "value");
  assert.equal(cache.get("a"), "value");
  clock = 999;
  assert.equal(cache.get("a"), "value");
  clock = 1000;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 0);
});

test("cache: oldest entry evicted when full, overwrite refreshes position", () => {
  const cache = new TtlCache(60_000, 2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 11); // refresh "a": now "b" is the oldest
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 11);
  assert.equal(cache.get("c"), 3);
});

// ---------- util.ts ----------

test("util: pickBySchema keeps only whitelisted fields, recursively and through arrays", () => {
  const input = { id: 1, secret: "x", nested: { keep: "k", drop: "d" }, list: [{ a: 1, b: 2 }] };
  const out = util.pickBySchema(input, { id: true, nested: { keep: true }, list: { a: true } });
  assert.deepEqual(out, { id: 1, nested: { keep: "k" }, list: [{ a: 1 }] });
});

test("util: cleanObject removes nulls and __typename", () => {
  const obj = { a: null, __typename: "X", b: { c: null, d: 1, __typename: "Y" } };
  util.cleanObject(obj);
  assert.deepEqual(obj, { b: { d: 1 } });
});

test("util: flattenArraysInObject joins arrays into strings", () => {
  assert.deepEqual(util.flattenArraysInObject({ tags: ["a", "b"] }), { tags: "a, b" });
  assert.deepEqual(util.flattenArraysInObject({ items: [{ t: "x", p: "1" }] }), { items: "x: 1" });
});

test("util: diagnoseJsonPath explains where a path breaks", () => {
  const data = { a: { b: { c: 1 } } };
  assert.equal(util.diagnoseJsonPath(data, ["a", "b", "c"]), "Path valid");
  assert.match(util.diagnoseJsonPath(data, ["a", "x"]), /Key 'x' not found. Available keys: \[b\]/);
  assert.match(util.diagnoseJsonPath(data, ["a", "b", "c", "d"]), /Path broken at 'd'/);
});

test("util: findPdpPresentation locates the branch or returns null", () => {
  const pdp = { amenities: {} };
  const data = { niobeClientData: [["k0", {}], ["k1", { data: { node: { pdpPresentation: pdp } } }]] };
  assert.equal(util.findPdpPresentation(data), pdp);
  assert.equal(util.findPdpPresentation({ niobeClientData: [] }), null);
  assert.equal(util.findPdpPresentation(undefined), null);
});

test("util: extractAmenities marks unavailable items only in mixed groups", () => {
  const pdp = {
    amenities: {
      title: "What this place offers",
      seeAllAmenitiesGroups: [
        {
          title: "Bathroom",
          amenities: [
            { title: "Hair dryer", available: true },
            { title: "Bathtub", available: false },
          ],
        },
        { title: "Not included", amenities: [{ title: "Air conditioning", available: false }] },
        { title: "Empty", amenities: [] },
      ],
    },
  };
  const out = util.extractAmenities(pdp);
  assert.equal(out.title, "What this place offers");
  assert.deepEqual(out.seeAllAmenitiesGroups, [
    { title: "Bathroom", amenities: ["Hair dryer", "Bathtub — unavailable"] },
    { title: "Not included", amenities: ["Air conditioning"] },
  ]);
  assert.equal(util.extractAmenities({}), null);
});

test("util: extractAmenities accepts string and { text } subtitles", () => {
  const out = util.extractAmenities({
    amenities: {
      seeAllAmenitiesGroups: [
        {
          title: "Kitchen",
          amenities: [
            { title: "Oven", subtitle: "Gas" },
            { title: "Fridge", subtitle: { text: "Mini" } },
          ],
        },
      ],
    },
  });
  assert.deepEqual(out.seeAllAmenitiesGroups[0].amenities, ["Oven (Gas)", "Fridge (Mini)"]);
});

test("util: keyAmenityGroups turns the group array into an object, merging duplicates", () => {
  const out = util.keyAmenityGroups({
    seeAllAmenitiesGroups: [
      { title: "Kitchen", amenities: ["Oven"] },
      { title: "Kitchen", amenities: ["Fridge"] },
      { amenities: ["Wifi"] },
      { title: "Empty", amenities: [] },
    ],
  });
  assert.deepEqual(out.seeAllAmenitiesGroups, { Kitchen: ["Oven", "Fridge"], Other: ["Wifi"] });
});

test("util: extractHighlights skips untitled entries instead of printing 'null'", () => {
  const out = util.extractHighlights({
    highlights: [
      { title: "Free parking", subtitle: "On premises" },
      { subtitle: "orphan subtitle" },
      { title: "Self check-in" },
    ],
  });
  assert.deepEqual(out, { highlights: ["Free parking: On premises", "Self check-in"] });
  assert.equal(util.extractHighlights({ highlights: [] }), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  compactSearchResult,
  extractPriceBreakdown,
  cleanObject,
  pickBySchema,
  flattenArraysInObject,
} from "../dist/util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "search-results.json"), "utf8")
);
const [typical, noBadges, malformed] = fixtures;
const BASE = "https://www.airbnb.com";

test("compactSearchResult decodes the listing id and derives the url", () => {
  const out = compactSearchResult(typical, BASE);
  assert.equal(out.id, "1700894224964602838");
  assert.equal(out.url, "https://www.airbnb.com/rooms/1700894224964602838");
});

test("compactSearchResult lifts the nested listing name to the top level", () => {
  const out = compactSearchResult(typical, BASE);
  assert.equal(out.name, "NEW! Mt. Hood Escape | Pool, Bunk Room & Dogs Okay");
});

test("compactSearchResult keeps coordinates as numbers", () => {
  const out = compactSearchResult(typical, BASE);
  assert.equal(out.latitude, 45.3651);
  assert.equal(out.longitude, -121.9887);
});

test("compactSearchResult preserves the bedroom/bed/bath line verbatim", () => {
  // This line is the only structured capacity information Airbnb exposes on a
  // search card, so it must survive compaction unaltered.
  assert.equal(compactSearchResult(typical, BASE).layout, "4 bedrooms, 5 beds, 2 baths");
  assert.equal(compactSearchResult(noBadges, BASE).layout, "4 bedrooms, 6 beds, 2.5 baths");
});

test("compactSearchResult strips the trailing separator from priceDetails", () => {
  const out = compactSearchResult(typical, BASE);
  assert.equal(out.priceDetails, "3 nights x $376.55: $1,129.65");
});

test("compactSearchResult keeps the full price label, including any discount", () => {
  assert.equal(
    compactSearchResult(typical, BASE).price,
    "$1,130 for 3 nights, originally $1,368"
  );
  assert.equal(compactSearchResult(noBadges, BASE).price, "$1,012 for 3 nights");
});

test("compactSearchResult omits absent and empty fields rather than emitting null", () => {
  const out = compactSearchResult(noBadges, BASE);
  assert.ok(!("badges" in out), "empty badges should be dropped");
  assert.ok(!("latitude" in out), "missing coordinate should be dropped");
  assert.ok(!("longitude" in out), "missing coordinate should be dropped");
  // The keys that do carry information must survive.
  assert.equal(out.name, "Hilltop Home w/ Hot Tub");
  assert.equal(out.rating, "4.95 out of 5 average rating, 191 reviews");
});

test("compactSearchResult drops the constant 'Price details' title", () => {
  const out = compactSearchResult(typical, BASE);
  assert.ok(!JSON.stringify(out).includes("Price details"));
});

test("compactSearchResult drops the redundant base64 listing id", () => {
  const out = compactSearchResult(typical, BASE);
  assert.ok(!JSON.stringify(out).includes("RGVtYW5kU3RheUxpc3Rpbmc"));
});

test("compactSearchResult survives a malformed result without throwing", () => {
  const out = compactSearchResult(malformed, BASE);
  assert.equal(out.layout, "2 bedrooms, 2 beds, 1 bath");
  assert.ok(!("id" in out), "an undecodable id should be omitted, not guessed");
  assert.ok(!("url" in out), "no url without an id");
});

test("compactSearchResult returns non-objects unchanged", () => {
  assert.equal(compactSearchResult(null, BASE), null);
  assert.equal(compactSearchResult("x", BASE), "x");
});

test("compaction saves bytes STRUCTURALLY, not just by dropping indentation", () => {
  // Measured like-for-like: unindented against unindented, so formatting cannot
  // flatter the result. Structure is the larger of the two effects (~64% here vs
  // ~22% from indentation), and this is the number that must not regress.
  const verbose = fixtures.map((r) => {
    let id;
    try {
      id = Buffer.from(r.demandStayListing.id, "base64").toString("utf8").split(":")[1];
    } catch {
      id = undefined;
    }
    return { id, url: `${BASE}/rooms/${id}`, ...r };
  });

  const verboseFlat = Buffer.byteLength(JSON.stringify(verbose), "utf8");
  const compactFlat = Buffer.byteLength(
    JSON.stringify(fixtures.map((r) => compactSearchResult(r, BASE))),
    "utf8"
  );

  const structural = 1 - compactFlat / verboseFlat;
  assert.ok(
    structural > 0.5,
    `structural reduction should exceed 50%, got ${(structural * 100).toFixed(1)}% ` +
      `(${verboseFlat} -> ${compactFlat} bytes, both unindented)`
  );
});

test("dropping indentation is a real but secondary saving", () => {
  const verbose = fixtures.map((r) => ({ ...r }));
  const pretty = Buffer.byteLength(JSON.stringify(verbose, null, 2), "utf8");
  const flat = Buffer.byteLength(JSON.stringify(verbose), "utf8");
  const formatting = 1 - flat / pretty;
  // Asserted as a band: large enough to be worth doing, small enough that nobody
  // mistakes it for where the win comes from.
  assert.ok(formatting > 0.1 && formatting < 0.4, `formatting saving was ${(formatting * 100).toFixed(1)}%`);
});

test("end-to-end compaction combines both effects", () => {
  // The verbose shape is what the server emits today: id + url spread over the
  // original nested result.
  const verbose = fixtures.map((r) => {
    let id;
    try {
      id = Buffer.from(r.demandStayListing.id, "base64").toString("utf8").split(":")[1];
    } catch {
      id = undefined;
    }
    return { id, url: `${BASE}/rooms/${id}`, ...r };
  });

  const before = Buffer.byteLength(JSON.stringify(verbose, null, 2), "utf8");
  const after = Buffer.byteLength(
    JSON.stringify(fixtures.map((r) => compactSearchResult(r, BASE))),
    "utf8"
  );

  const saved = 1 - after / before;
  assert.ok(
    saved > 0.5,
    `expected >50% reduction, got ${(saved * 100).toFixed(1)}% (${before} -> ${after} bytes)`
  );
});

const prices = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "price-details.json"), "utf8")
);

test("extractPriceBreakdown flattens line groups into ordered line items", () => {
  const out = extractPriceBreakdown(prices.discounted);
  assert.deepEqual(out.lineItems, [
    { description: "3 nights x $890.67", price: "$2,672.00" },
    { description: "Special offer", price: "-$52.50", type: "discount" },
    { description: "Price after discount", price: "$2,522.00", type: "total" },
  ]);
});

test("extractPriceBreakdown labels discount and total items by their __typename", () => {
  const items = extractPriceBreakdown(prices.discounted).lineItems;
  assert.equal(items.find((i) => i.description === "Special offer").type, "discount");
  assert.equal(items.find((i) => i.description === "Price after discount").type, "total");
  // A plain subtotal is untyped rather than mislabelled.
  assert.ok(!("type" in items[0]));
});

test("extractPriceBreakdown surfaces the before-taxes caveat when Airbnb states it", () => {
  assert.equal(extractPriceBreakdown(prices.discounted).note, "$2,522.00 total before taxes");
});

test("extractPriceBreakdown omits the note when Airbnb does not state it", () => {
  // The label lives only on highlight items, so most listings have no tax statement.
  // Absent must mean absent — never a default that implies taxes are included.
  const out = extractPriceBreakdown(prices.plain);
  assert.ok(!("note" in out), "no note should be invented when the payload has none");
  assert.deepEqual(out.lineItems, [
    { description: "3 nights x $1,083.83", price: "$3,251.49" },
  ]);
});

test("extractPriceBreakdown returns null when there is no price explanation", () => {
  assert.equal(extractPriceBreakdown(prices.empty), null);
  assert.equal(extractPriceBreakdown({}), null);
  assert.equal(extractPriceBreakdown(null), null);
});

test("extractPriceBreakdown keeps the sign of a discount", () => {
  // "-$52.50" flattened into a joined string loses nothing textually, but a caller
  // summing line items needs the sign to survive as part of the value.
  const items = extractPriceBreakdown(prices.discounted).lineItems;
  assert.ok(items.some((i) => i.price.startsWith("-")));
});

test("compactSearchResult prefers a structured breakdown over the flattened string", () => {
  const breakdown = extractPriceBreakdown(prices.discounted);
  const out = compactSearchResult(typical, BASE, breakdown);
  assert.deepEqual(out.priceBreakdown, breakdown);
  assert.ok(!("priceDetails" in out), "the lossy string should not be emitted alongside");
});

test("compactSearchResult keeps the flattened string when no breakdown is supplied", () => {
  const out = compactSearchResult(typical, BASE);
  assert.equal(out.priceDetails, "3 nights x $376.55: $1,129.65");
  assert.ok(!("priceBreakdown" in out));
});

// The helpers compaction is built on had no coverage at all.

test("pickBySchema copies only the keys the schema names", () => {
  const out = pickBySchema({ a: 1, b: 2, c: { d: 3, e: 4 } }, { a: true, c: { d: true } });
  assert.deepEqual(out, { a: 1, c: { d: 3 } });
});

test("pickBySchema maps over arrays", () => {
  const out = pickBySchema([{ a: 1, b: 2 }, { a: 3, b: 4 }], { a: true });
  assert.deepEqual(out, [{ a: 1 }, { a: 3 }]);
});

test("pickBySchema returns an empty object when the source is empty", () => {
  // This is why a stubbed section reads as "no data" rather than "extraction broke".
  assert.deepEqual(pickBySchema({}, { a: true }), {});
});

test("cleanObject removes nulls and __typename in place", () => {
  const o = { a: 1, b: null, __typename: "X", c: { d: null, __typename: "Y", e: 2 } };
  cleanObject(o);
  assert.deepEqual(o, { a: 1, c: { e: 2 } });
});

test("flattenArraysInObject joins arrays of objects into a string", () => {
  assert.equal(
    flattenArraysInObject({ items: [{ title: "a" }, { title: "b" }] }).items,
    "a, b"
  );
});

test("flattenArraysInObject leaves primitives alone", () => {
  assert.deepEqual(flattenArraysInObject({ a: 1, b: "x" }), { a: 1, b: "x" });
});

test("structured priceBreakdown shape is destroyed if passed through flattenArraysInObject", () => {
  // Documented composition rule on 0.3.0: extractPriceBreakdown MUST run before
  // cleanObject, and the result must be attached AFTER flattenArraysInObject.
  // flattenArraysInObject joins arrays-of-objects into a string, so the structured
  // lineItems array does not survive a direct flatten — which is why the search path
  // never flattens the breakdown itself.
  const breakdown = extractPriceBreakdown(prices.discounted);
  assert.ok(Array.isArray(breakdown.lineItems));
  assert.equal(typeof breakdown.lineItems[0], "object");
  const flattened = flattenArraysInObject(breakdown);
  assert.equal(typeof flattened.lineItems, "string");
  assert.ok(flattened.lineItems.includes("Special offer"));
});

test("attaching priceBreakdown after flatten preserves the structured shape", () => {
  // Mirrors the airbnb_search path: flatten the card, then set priceBreakdown.
  const card = flattenArraysInObject({
    structuredDisplayPrice: {
      primaryLine: { accessibilityLabel: "$1,130 for 3 nights" },
      explanationData: { priceDetails: "3 nights x $376.55: $1,129.65" },
    },
  });
  const breakdown = extractPriceBreakdown(prices.discounted);
  const out = { ...card, priceBreakdown: breakdown };
  assert.deepEqual(out.priceBreakdown.lineItems, breakdown.lineItems);
  assert.equal(out.priceBreakdown.note, "$2,522.00 total before taxes");
  assert.ok(Array.isArray(out.priceBreakdown.lineItems));
});

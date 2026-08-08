import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  findPdpPresentation,
  extractAmenities,
  extractHighlights,
  compactSearchResult,
} from "../dist/util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "pdp-presentation.json"), "utf8")
);
const BASE = "https://www.airbnb.com";

test("findPdpPresentation locates the branch without hardcoding an index", () => {
  assert.ok(findPdpPresentation(fx.healthy));
  assert.equal(findPdpPresentation(fx.noPdpBranch), null);
  assert.equal(findPdpPresentation({}), null);
  assert.equal(findPdpPresentation(null), null);
});

test("extractAmenities preserves availability intent without fabricating available lists", () => {
  // Upstream 0.3.0 shape: each group is { title, amenities: string[] }.
  // Pure "Not included" groups rely on the group title rather than per-item
  // "— unavailable" suffixes; mixed groups mark only the unavailable items.
  const out = extractAmenities(findPdpPresentation(fx.healthy));
  const heat = out.seeAllAmenitiesGroups.find((g) => g.title === "Heating and cooling");
  const not = out.seeAllAmenitiesGroups.find((g) => g.title === "Not included");
  assert.deepEqual(heat.amenities, ["Central air conditioning", "Ceiling fan"]);
  assert.deepEqual(not.amenities, ["Dryer", "Hot water"]);
  assert.ok(!not.amenities.some((a) => a.includes("unavailable")),
    "uniform unavailable groups use the group title, not per-item marks");
});

test("extractHighlights joins a subtitle onto its title when present", () => {
  const out = extractHighlights(findPdpPresentation(fx.healthy));
  assert.deepEqual(out.highlights, [
    "Dive right in: This is one of the few places in the area with a pool.",
    "Peace and quiet",
  ]);
});

// --- partial extraction: one field failing must not cost the others ---

test("amenities still extract when highlights are gone", () => {
  const pdp = findPdpPresentation(fx.amenitiesOnly);
  const amenities = extractAmenities(pdp);
  assert.ok(amenities, "amenities must survive a missing highlights field");
  assert.deepEqual(amenities.seeAllAmenitiesGroups[0].amenities, [
    "AC - split type ductless system",
  ]);
  assert.equal(extractHighlights(pdp), null, "missing highlights report as null, not as an error");
});

test("a malformed amenity group does not destroy the healthy groups around it", () => {
  const out = extractAmenities(findPdpPresentation(fx.partiallyMalformedGroups));
  const titles = out.seeAllAmenitiesGroups.map((g) => g.title);
  assert.ok(titles.includes("Bathroom"), "groups before the bad one must survive");
  assert.ok(titles.includes("Kitchen"), "groups after the bad one must survive");
  const bathroom = out.seeAllAmenitiesGroups.find((g) => g.title === "Bathroom");
  assert.deepEqual(bathroom.amenities, ["Hair dryer"]);
});

test("extraction returns null rather than throwing when the branch moves", () => {
  assert.equal(extractAmenities(null), null);
  assert.equal(extractAmenities({}), null);
  assert.equal(extractHighlights(null), null);
  assert.equal(extractHighlights({}), null);
});

// --- BLOCKER: base64 decoding must not fabricate a listing id ---

test("compactSearchResult rejects a corrupt id that decodes to a colon-bearing string", () => {
  // Buffer.from(x, "base64") does NOT throw on invalid input - it silently skips
  // invalid characters and decodes the rest. The hyphen here is ignored, so this
  // garbage decodes cleanly to "Corrupt:12345" and a naive split(":")[1] yields the
  // plausible-looking id "12345" for a listing that does not exist.
  const corrupt = { demandStayListing: { id: "Q29ycnVwdDox-MjM0NQ==" } };
  const out = compactSearchResult(corrupt, BASE);
  assert.ok(!("id" in out), "a corrupt id must be omitted, never guessed");
  assert.ok(!("url" in out), "no url may be built from a fabricated id");
});

test("compactSearchResult accepts a genuine DemandStayListing id", () => {
  const real = { demandStayListing: { id: "RGVtYW5kU3RheUxpc3Rpbmc6NTM2MTA3MTU=" } };
  const out = compactSearchResult(real, BASE);
  assert.equal(out.id, "53610715");
  assert.equal(out.url, "https://www.airbnb.com/rooms/53610715");
});

test("compactSearchResult rejects a decoded value with the wrong prefix", () => {
  // Base64 of "SomethingElse:53610715" - valid base64, wrong entity.
  const wrong = { demandStayListing: { id: Buffer.from("SomethingElse:53610715").toString("base64") } };
  assert.ok(!("id" in compactSearchResult(wrong, BASE)));
});

test("compactSearchResult rejects a non-numeric listing id", () => {
  const wrong = { demandStayListing: { id: Buffer.from("DemandStayListing:abc").toString("base64") } };
  assert.ok(!("id" in compactSearchResult(wrong, BASE)));
});

test("a result with an unusable id still returns everything else it has", () => {
  // Partial output beats all-or-nothing: the layout and price are still worth having
  // even when the id cannot be trusted.
  const out = compactSearchResult(
    {
      demandStayListing: { id: "!!!not-base64!!!", description: { name: { localizedStringWithTranslationPreference: "A Cabin" } } },
      structuredContent: { primaryLine: "4 bedrooms, 5 beds, 3 baths" },
    },
    BASE
  );
  assert.equal(out.name, "A Cabin");
  assert.equal(out.layout, "4 bedrooms, 5 beds, 3 baths");
  assert.ok(!("id" in out));
});

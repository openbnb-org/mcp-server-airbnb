import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  findPdpPresentation,
  extractAmenities,
  extractHighlights,
  keyAmenityGroups,
} from "../dist/util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "pdp-presentation.json"), "utf8")
);

test("findPdpPresentation locates the branch without hardcoding an index", () => {
  assert.ok(findPdpPresentation(fx.healthy));
  assert.equal(findPdpPresentation(fx.noPdpBranch), null);
  assert.equal(findPdpPresentation({}), null);
  assert.equal(findPdpPresentation(null), null);
});

test("extractAmenities passes through the section title", () => {
  const out = extractAmenities(findPdpPresentation(fx.healthy));
  assert.equal(out.title, "What this place offers");
});

test("an all-unavailable group is left unmarked; its title carries the meaning", () => {
  const out = extractAmenities(findPdpPresentation(fx.healthy));
  const heat = out.seeAllAmenitiesGroups.find((g) => g.title === "Heating and cooling");
  const not = out.seeAllAmenitiesGroups.find((g) => g.title === "Not included");
  assert.deepEqual(heat.amenities, ["Central air conditioning", "Ceiling fan"]);
  // available:false is how Airbnb renders a struck-through amenity. The mechanism
  // is availability homogeneity, not the group's title: a group where every item
  // shares the same availability is left unmarked because the group's own name -
  // whatever it is - already tells the story. Only a group mixing available and
  // unavailable items needs its unavailable items called out individually. This
  // fixture's homogeneous group happens to be titled "Not included", but that
  // title is not what triggers the behavior - see the next test.
  assert.deepEqual(not.amenities, ["Dryer", "Hot water"]);
});

test("a homogeneously-unavailable group is left unmarked under any title, not just 'Not included'", () => {
  const pdp = {
    amenities: {
      seeAllAmenitiesGroups: [
        {
          title: "Kitchen extras",
          amenities: [
            { title: "Wine glasses", available: false },
            { title: "Coffee maker", available: false },
          ],
        },
      ],
    },
  };
  const out = extractAmenities(pdp);
  assert.deepEqual(out.seeAllAmenitiesGroups[0].amenities, ["Wine glasses", "Coffee maker"]);
});

test("a group mixing available and unavailable items marks the unavailable ones", () => {
  const pdp = {
    amenities: {
      seeAllAmenitiesGroups: [
        {
          title: "Laundry",
          amenities: [
            { title: "Washer", available: true },
            { title: "Dryer", available: false },
          ],
        },
      ],
    },
  };
  const out = extractAmenities(pdp);
  assert.deepEqual(out.seeAllAmenitiesGroups[0].amenities, [
    "Washer",
    "Dryer — unavailable",
  ]);
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

test("extractAmenities returns null when every group is empty", () => {
  const pdp = {
    amenities: {
      seeAllAmenitiesGroups: [
        { title: "Bathroom", amenities: [] },
        { title: "Kitchen", amenities: [] },
      ],
    },
  };
  assert.equal(extractAmenities(pdp), null);
});

// --- subtitle shape: Airbnb has shipped this as both a plain string and a
// { text } object, on both amenities and highlights. Both must label the same. ---

test("extractAmenities labels a string subtitle and a { text } subtitle identically", () => {
  const pdp = findPdpPresentation(fx.subtitleShapes);
  const out = extractAmenities(pdp);
  assert.deepEqual(out.seeAllAmenitiesGroups[0].amenities, [
    "Shampoo (Body wash)",
    "Hair dryer (1200W)",
  ]);
});

test("extractHighlights labels a string subtitle and a { text } subtitle identically", () => {
  const pdp = findPdpPresentation(fx.subtitleShapes);
  const out = extractHighlights(pdp);
  assert.deepEqual(out.highlights, [
    "Great location: Walk to the beach",
    "Self check-in: Check yourself in with the keypad.",
  ]);
});

// --- keyAmenityGroups: no coverage at all before this branch ---

test("keyAmenityGroups keys groups by title", () => {
  const section = {
    seeAllAmenitiesGroups: [
      { title: "Bathroom", amenities: [{ title: "Hair dryer" }] },
      { title: "Kitchen", amenities: [{ title: "Oven" }] },
    ],
  };
  const out = keyAmenityGroups(section);
  assert.deepEqual(out.seeAllAmenitiesGroups, {
    Bathroom: [{ title: "Hair dryer" }],
    Kitchen: [{ title: "Oven" }],
  });
});

test("keyAmenityGroups falls back to 'Other' for an untitled group", () => {
  const section = {
    seeAllAmenitiesGroups: [{ amenities: [{ title: "Mystery item" }] }],
  };
  const out = keyAmenityGroups(section);
  assert.deepEqual(out.seeAllAmenitiesGroups, { Other: [{ title: "Mystery item" }] });
});

test("keyAmenityGroups merges duplicate titles by concatenation, not overwrite", () => {
  const section = {
    seeAllAmenitiesGroups: [
      { title: "Bathroom", amenities: [{ title: "Hair dryer" }] },
      { title: "Bathroom", amenities: [{ title: "Shampoo" }] },
    ],
  };
  const out = keyAmenityGroups(section);
  assert.deepEqual(out.seeAllAmenitiesGroups.Bathroom, [
    { title: "Hair dryer" },
    { title: "Shampoo" },
  ]);
});

test("keyAmenityGroups drops groups that have no amenities", () => {
  const section = {
    seeAllAmenitiesGroups: [
      { title: "Bathroom", amenities: [] },
      { title: "Kitchen", amenities: [{ title: "Oven" }] },
    ],
  };
  const out = keyAmenityGroups(section);
  assert.deepEqual(out.seeAllAmenitiesGroups, { Kitchen: [{ title: "Oven" }] });
  assert.ok(!("Bathroom" in out.seeAllAmenitiesGroups));
});

test("keyAmenityGroups passes through non-matching objects, arrays, and null unchanged", () => {
  assert.equal(keyAmenityGroups(null), null);
  assert.equal(keyAmenityGroups(42), 42);

  const arr = [1, 2, 3];
  assert.equal(keyAmenityGroups(arr), arr);

  const noGroups = { foo: "bar" };
  assert.deepEqual(keyAmenityGroups(noGroups), noGroups);
});

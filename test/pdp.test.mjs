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
  extractMediaTour,
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

// --- photo tour (mediaTour / sleepingArrangements / bathroomsTour): per-room
// amenity fingerprint is the primary payload, not the images. A listing can claim
// N bedrooms while one "bedroom" stop is missing the amenities its peers all carry
// (Clothing storage, Hangers, Essentials, Room-darkening shades) - that gap is what
// exposes a capacity-vs-reality mismatch on a group trip. Raw image data (uri,
// imageId, assetMetadata, tags) is deliberately never emitted: this fork's whole
// selling point is staying far below stock token cost. ---

test("extractMediaTour returns stop names, deduped captions, and per-room amenities", () => {
  const pdp = findPdpPresentation(fx.photoTour);
  const out = extractMediaTour(pdp?.mediaTour);
  assert.equal(out.sectionTitle, "Photo tour");

  const bedroom1 = out.stops.find((s) => s.name === "Bedroom 1");
  assert.deepEqual(bedroom1.captions, [
    "Master bedroom with king bed and attached master bathroom on main level",
  ]);
  assert.deepEqual(bedroom1.amenities, [
    "King bed",
    "Bed linens",
    "Clothing storage",
    "Essentials",
    "Extra pillows and blankets",
    "Hangers",
    "Heating",
    "Room-darkening shades",
  ]);

  // Never emit image internals - that's the whole point of the compact shape.
  const json = JSON.stringify(out);
  assert.ok(!json.includes("imageId"));
  assert.ok(!json.includes("assetMetadata"));
  assert.ok(!json.includes("uri"));
  assert.ok(!json.includes("tags"));
});

test("extractMediaTour surfaces the real-world discriminator: Bedroom 5 is missing amenities Bedrooms 1-4 all carry, Game room lists Bed linens", () => {
  const pdp = findPdpPresentation(fx.photoTour);
  const out = extractMediaTour(pdp?.mediaTour);

  const b1 = out.stops.find((s) => s.name === "Bedroom 1").amenities;
  const b2 = out.stops.find((s) => s.name === "Bedroom 2").amenities;
  const b3 = out.stops.find((s) => s.name === "Bedroom 3").amenities;
  const b4 = out.stops.find((s) => s.name === "Bedroom 4").amenities;
  const b5 = out.stops.find((s) => s.name === "Bedroom 5").amenities;
  const gameRoom = out.stops.find((s) => s.name === "Game room").amenities;

  for (const amenity of ["Clothing storage", "Hangers", "Essentials", "Room-darkening shades"]) {
    assert.ok(b1.includes(amenity), `Bedroom 1 must list ${amenity}`);
    assert.ok(b2.includes(amenity), `Bedroom 2 must list ${amenity}`);
    assert.ok(b3.includes(amenity), `Bedroom 3 must list ${amenity}`);
    assert.ok(b4.includes(amenity), `Bedroom 4 must list ${amenity}`);
    assert.ok(!b5.includes(amenity), `Bedroom 5 must NOT list ${amenity} - this is the discriminator`);
  }
  assert.ok(gameRoom.includes("Bed linens"), "Game room lists Bed linens despite not being a bedroom stop");
});

test("extractMediaTour drops null captions but keeps the stop's other captions", () => {
  const pdp = findPdpPresentation(fx.photoTourCaptionEdgeCases);
  const out = extractMediaTour(pdp?.mediaTour);
  const kitchen = out.stops.find((s) => s.name === "Kitchen");
  // null caption dropped, whitespace-only caption dropped, duplicate "Full kitchen"
  // deduped, and the last item falls back to localizedString since
  // localizedStringWithTranslationPreference is absent on it.
  assert.deepEqual(kitchen.captions, ["Full kitchen", "Fallback caption text"]);
});

test("extractMediaTour still returns a stop's name and captions when description is missing", () => {
  const pdp = findPdpPresentation(fx.photoTourDescriptionMissing);
  const out = extractMediaTour(pdp?.mediaTour);
  const exterior = out.stops.find((s) => s.name === "Exterior");
  assert.equal(exterior.name, "Exterior");
  assert.deepEqual(exterior.captions, ["Backyard with hot tub"]);
  assert.ok(!("amenities" in exterior), "missing description must omit amenities, never emit null/[]");
});

test("extractMediaTour returns null when the tour key itself is absent, without throwing", () => {
  const pdp = findPdpPresentation(fx.photoTourKeyAbsent);
  assert.ok(extractMediaTour(pdp?.mediaTour), "mediaTour is present on this fixture");
  assert.equal(extractMediaTour(pdp?.sleepingArrangements), null, "sleepingArrangements is absent");
  assert.equal(extractMediaTour(pdp?.bathroomsTour), null, "bathroomsTour is absent");
  assert.equal(extractMediaTour(undefined), null);
  assert.equal(extractMediaTour(null), null);
});

test("extractMediaTour returns null when stops is an empty array", () => {
  const pdp = findPdpPresentation(fx.photoTourStopsEmpty);
  assert.equal(extractMediaTour(pdp?.bathroomsTour), null);
});

test("extractMediaTour returns null when stops is missing entirely, without throwing", () => {
  const pdp = findPdpPresentation(fx.photoTourStopsMissing);
  assert.doesNotThrow(() => extractMediaTour(pdp?.mediaTour));
  assert.equal(extractMediaTour(pdp?.mediaTour), null);
});

test("extractMediaTour never throws on a garbage or empty input", () => {
  assert.doesNotThrow(() => extractMediaTour({}));
  assert.doesNotThrow(() => extractMediaTour("not an object"));
  assert.doesNotThrow(() => extractMediaTour({ stops: "not an array" }));
  assert.doesNotThrow(() => extractMediaTour({ stops: [null, undefined, 42] }));
});

test("extractMediaTour extracts sleepingArrangements with real content", () => {
  const pdp = findPdpPresentation(fx.otherTours);
  const out = extractMediaTour(pdp?.sleepingArrangements);
  assert.equal(out.sectionTitle, "Where you'll sleep");
  const b1 = out.stops.find((s) => s.name === "Bedroom 1");
  assert.deepEqual(b1.captions, ["King bed"]);
  assert.deepEqual(b1.amenities, ["King bed"]);
});

test("extractMediaTour extracts bathroomsTour with real content", () => {
  const pdp = findPdpPresentation(fx.otherTours);
  const out = extractMediaTour(pdp?.bathroomsTour);
  assert.equal(out.sectionTitle, "What's the bathroom like");
  const b1 = out.stops.find((s) => s.name === "Bathroom 1");
  assert.deepEqual(b1.captions, ["Shower"]);
  assert.deepEqual(b1.amenities, ["Hot water", "Shampoo"]);
});

test("extractMediaTour still returns a stop's captions when name is missing", () => {
  const pdp = findPdpPresentation(fx.photoTourNameMissing);
  const out = extractMediaTour(pdp?.mediaTour);
  const stop = out.stops[0];
  assert.ok(!("name" in stop), "missing name must omit name key");
  assert.deepEqual(stop.captions, ["A nice room"]);
  assert.deepEqual(stop.amenities, ["Some amenity"]);
});

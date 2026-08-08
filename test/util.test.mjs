import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  cleanObject,
  pickBySchema,
  flattenArraysInObject,
  searchBadgeSchema,
  extractBadgeType,
} from "../dist/util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const badgeFx = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "search-badges.json"), "utf8")
);

/** Full search-card pipeline: clean → extract type → pick → flatten → attach. */
function projectSearchCard(raw) {
  const clone = structuredClone(raw);
  cleanObject(clone);
  const badgeType = extractBadgeType(clone);
  const flat = flattenArraysInObject(pickBySchema(clone, { badges: searchBadgeSchema }));
  if (badgeType) flat.badgeType = badgeType;
  return flat;
}

// The helpers amenity/highlight recovery is built on had no coverage at all.

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

// --- search badges: flattened text stays pre-fix; badgeType is a sibling key ---

test("badge schema projects only text (badgeType never enters the flatten pipeline)", () => {
  const raw = structuredClone(badgeFx.guestFavoriteButSuperhost);
  cleanObject(raw);
  const projected = pickBySchema(raw, { badges: searchBadgeSchema });
  assert.deepEqual(projected.badges, [{ text: "Guest favorite" }]);
  assert.equal(projected.badges[0].loggingContext, undefined);
});

test("flattened badges string is byte-identical to pre-fix Guest favorite output", () => {
  // Pre-fix: badges: { text: true } → flatten → "Guest favorite".
  // Superhost must NOT leak into that string (no "Guest favorite: SUPERHOST").
  const out = projectSearchCard(badgeFx.guestFavoriteButSuperhost);
  assert.equal(out.badges, "Guest favorite");
  assert.equal(out.badgeType, "SUPERHOST");
});

test("extractBadgeType returns SUPERHOST and TOP_X_GUEST_FAVORITE types", () => {
  for (const [key, expected] of [
    ["superhostBadge", "SUPERHOST"],
    ["guestFavoriteOnly", "TOP_X_GUEST_FAVORITE"],
    ["guestFavoriteButSuperhost", "SUPERHOST"],
  ]) {
    const raw = structuredClone(badgeFx[key]);
    cleanObject(raw);
    assert.equal(extractBadgeType(raw), expected, key);
  }
});

test("text-only badges flatten without a badgeType key", () => {
  const out = projectSearchCard(badgeFx.textOnlyBadge);
  assert.equal(out.badges, "Guest favorite");
  assert.equal(out.badgeType, undefined);
});

test("extractBadgeType returns null when badges or loggingContext are absent", () => {
  assert.equal(extractBadgeType(null), null);
  assert.equal(extractBadgeType({}), null);
  assert.equal(extractBadgeType({ badges: [{ text: "Guest favorite" }] }), null);
});

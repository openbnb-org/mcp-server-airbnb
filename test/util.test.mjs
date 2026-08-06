import test from "node:test";
import assert from "node:assert/strict";

import { cleanObject, pickBySchema, flattenArraysInObject } from "../dist/util.js";

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

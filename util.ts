export function cleanObject(obj: any) {
  Object.keys(obj).forEach(key => {
    if (obj[key] == null || key === "__typename") {
      delete obj[key];
    } else if (typeof obj[key] === "object") {
      cleanObject(obj[key]);
    }
  });
}

export function diagnoseJsonPath(data: any, path: string[]): string {
  let current = data;
  for (const key of path) {
    if (current == null || typeof current !== 'object') {
      return `Path broken at '${key}': parent is ${current === null ? 'null' : typeof current}`;
    }
    if (!(key in current)) {
      const available = Object.keys(current).slice(0, 10).join(', ');
      return `Key '${key}' not found. Available keys: [${available}]`;
    }
    current = current[key];
  }
  return 'Path valid';
}

export function pickBySchema(obj: any, schema: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  // If the object is an array, process each item
  if (Array.isArray(obj)) {
    return obj.map(item => pickBySchema(item, schema));
  }
  
  const result: Record<string, any> = {};
  for (const key in schema) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const rule = schema[key];
      // If the rule is true, copy the value as-is
      if (rule === true) {
        result[key] = obj[key];
      }
      // If the rule is an object, apply the schema recursively
      else if (typeof rule === 'object' && rule !== null) {
        result[key] = pickBySchema(obj[key], rule);
      }
    }
  }
  return result;
}

export function flattenArraysInObject(input: any, inArray: boolean = false): any {
  if (Array.isArray(input)) {
    // Process each item in the array with inArray=true so that any object
    // inside the array is flattened to a string.
    const flatItems = input.map(item => flattenArraysInObject(item, true));
    return flatItems.join(', ');
  } else if (typeof input === 'object' && input !== null) {
    if (inArray) {
      // When inside an array, ignore the keys and flatten the object's values.
      const values = Object.values(input).map(value => flattenArraysInObject(value, true));
      return values.join(': ');
    } else {
      // When not in an array, process each property recursively.
      const result: Record<string, any> = {};
      for (const key in input) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
          result[key] = flattenArraysInObject(input[key], false);
        }
      }
      return result;
    }
  } else {
    // For primitives, simply return the value.
    return input;
  }
}

/**
 * Airbnb moved several PDP sections to client-side rendering. Their entries under
 * `presentation.stayProductDetailPage.sections.sections` still exist, still report
 * sectionContentStatus COMPLETE, but carry a `section` object containing nothing but
 * `__typename`. AMENITIES_DEFAULT and HIGHLIGHTS_DEFAULT are both in that state, so
 * the schema-driven extraction returns an empty shell rather than failing loudly.
 *
 * The content now lives on a sibling branch of the same payload:
 *   niobeClientData[i][1].data.node.pdpPresentation
 *
 * Returns null when the branch is absent, so callers fall back to whatever the
 * section tree gave them rather than losing data if Airbnb moves it again.
 */
export function findPdpPresentation(clientData: any): any | null {
  const entries = clientData?.niobeClientData;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const pdp = entry?.[1]?.data?.node?.pdpPresentation;
    if (pdp && typeof pdp === "object") return pdp;
  }
  return null;
}

/**
 * Airbnb also stubs LOCATION_DEFAULT under the same client-side-rendering move that
 * hits AMENITIES_DEFAULT and HIGHLIGHTS_DEFAULT — sectionContentStatus COMPLETE, but
 * the section carries no coordinates. Unlike those two, LOCATION_DEFAULT's recovery
 * source is not `pdpPresentation` — it's a sibling branch of the same node:
 *
 *   niobeClientData[i][1].data.node.location
 *
 * Mirrors findPdpPresentation exactly (same loop, same "don't hardcode the index"
 * reasoning), just pointed at a different field of the same node.
 */
export function findNodeLocation(clientData: any): any | null {
  const entries = clientData?.niobeClientData;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const location = entry?.[1]?.data?.node?.location;
    if (location && typeof location === "object") return location;
  }
  return null;
}

/**
 * Pull {lat, lng} off a `location` node. Both coordinates must be present and
 * numeric — a lone lat or lng is not a usable location, and emitting a half-formed
 * pair would let a caller mistake it for a real one. Returns null rather than
 * fabricating a value when the branch is stubbed, empty, or absent.
 */
export function extractLocationCoordinate(location: any): { lat: number; lng: number } | null {
  const lat = location?.coordinate?.latitude;
  const lng = location?.coordinate?.longitude;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * Apply the recovered coordinate to LOCATION_DEFAULT, following the same
 * replace-the-stub / add-if-absent shape as the fromPdp recovery in
 * handleAirbnbListingDetails. A section that already carries valid lat/lng passes
 * through untouched — present-and-valid values always win over recovery. When
 * `coordinate` is null (recovery found nothing either), the sections are returned
 * unchanged rather than stripped or fabricated.
 */
export function recoverLocationSection(sections: any[], coordinate: { lat: number; lng: number } | null): any[] {
  if (!coordinate) return sections;

  const hasCoords = (section: any) =>
    Number.isFinite(section?.lat) && Number.isFinite(section?.lng);

  let found = false;
  const result = sections.map((section: any) => {
    if (section?.id !== "LOCATION_DEFAULT") return section;
    found = true;
    if (hasCoords(section)) return section;
    return { id: section.id, ...coordinate };
  });

  if (!found) {
    result.push({ id: "LOCATION_DEFAULT", ...coordinate });
  }
  return result;
}

/**
 * Amenity groups, preserving each item's `available` flag.
 *
 * The flag is the whole point: Airbnb renders unavailable amenities struck through,
 * and a listing that advertises air conditioning in its description while carrying
 * `available: false` on the amenity is the exact case a reader needs to catch.
 * Grouping by availability makes that impossible to skim past, where a flat list of
 * titles would quietly assert the opposite of the truth.
 */
export function extractAmenities(pdp: any): any | null {
  const groups = pdp?.amenities?.seeAllAmenitiesGroups;
  if (!Array.isArray(groups) || groups.length === 0) return null;

  const label = (a: any, markUnavailable: boolean) => {
    const title = a?.title;
    if (!title) return null;
    // Airbnb has shipped this as both a plain string and a { text } object.
    const sub = typeof a?.subtitle === "string" ? a.subtitle : a?.subtitle?.text;
    const base = sub ? `${title} (${sub})` : title;
    return markUnavailable && a?.available === false ? `${base} — unavailable` : base;
  };

  const mapped = groups
    .map((group: any) => {
      const items = Array.isArray(group?.amenities) ? group.amenities : [];
      // Airbnb files struck-through amenities under a group of their own ("Not
      // included"), where the category name already carries the meaning and marking
      // each item would just repeat it. A group holding both is the case that needs
      // help: the name cannot speak for every item, so the unavailable ones say it
      // themselves rather than reading as amenities the listing offers.
      const mixed =
        items.some((a: any) => a?.available === false) &&
        items.some((a: any) => a?.available !== false);
      const amenities = items.map((a: any) => label(a, mixed)).filter(Boolean);
      return amenities.length ? { title: group?.title, amenities } : null;
    })
    .filter(Boolean);

  if (!mapped.length) return null;

  return {
    ...(pdp?.amenities?.title ? { title: pdp.amenities.title } : {}),
    seeAllAmenitiesGroups: mapped,
  };
}

/**
 * Turn `[{ title: "Bathroom", amenities: [...] }, ...]` into `{ Bathroom: [...], ... }`.
 *
 * The category is the useful part of an amenity list, and as an array element its title
 * survives only as a prefix inside one long joined string — a consumer that wants the
 * bathroom amenities has to parse them back out, and cannot tell a category boundary
 * from a comma inside a category. As an object key it is addressable directly, and
 * flattenArraysInObject leaves top-level keys alone, so each category flattens to its
 * own string. Airbnb's own "Not included" group lands here like any other category.
 *
 * Applied to both the section tree and the recovered pdpPresentation content so the two
 * paths cannot disagree about the shape. Untitled groups fall back to "Other" rather
 * than being dropped, and duplicate titles merge instead of overwriting.
 */
export function keyAmenityGroups(section: any): any {
  if (section === null || typeof section !== "object" || Array.isArray(section)) return section;

  const groups = section.seeAllAmenitiesGroups;
  if (!Array.isArray(groups)) return section;

  const keyed: Record<string, any[]> = {};
  for (const group of groups) {
    const items = Array.isArray(group?.amenities) ? group.amenities : [];
    if (!items.length) continue;
    const key = group?.title || "Other";
    keyed[key] = keyed[key] ? keyed[key].concat(items) : items;
  }

  return { ...section, seeAllAmenitiesGroups: keyed };
}

export function extractHighlights(pdp: any): any | null {
  const highlights = pdp?.highlights;
  if (!Array.isArray(highlights) || highlights.length === 0) return null;
  const mapped = highlights
    .map((h: any) => {
      const title = h?.title;
      // Interpolating first would turn a missing title into the literal string
      // "null: Free parking on premises", which .filter(Boolean) cannot catch.
      if (!title) return null;
      // Airbnb has shipped this as both a plain string and a { text } object.
      const sub = typeof h?.subtitle === "string" ? h.subtitle : h?.subtitle?.text;
      return sub ? `${title}: ${sub}` : title;
    })
    .filter(Boolean);

  return mapped.length ? { highlights: mapped } : null;
}

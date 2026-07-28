/**
 * Decode a `demandStayListing.id` — base64 of `"DemandStayListing:<numeric id>"`.
 *
 * The decode cannot be trusted on its own. `Buffer.from(x, "base64")` does not throw on
 * invalid input; it silently skips characters outside the alphabet and decodes whatever
 * remains. So `"Q29ycnVwdDox-MjM0NQ=="` — malformed, because of the hyphen — still decodes
 * cleanly to `"Corrupt:12345"`, and a naive `split(":")[1]` hands back the plausible-looking
 * id `12345` for a listing that does not exist. A try/catch cannot help, because nothing
 * throws.
 *
 * The guard is therefore on the decoded VALUE, not on the encoding: it must be exactly the
 * entity we expect. Returns undefined otherwise, so the caller omits the id rather than
 * publishing a fabricated one — and, per partial-output, keeps every other field.
 */
export function decodeListingId(encoded: unknown): string | undefined {
  if (typeof encoded !== "string" || encoded.length === 0) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const match = /^DemandStayListing:(\d+)$/.exec(decoded);
  return match ? match[1] : undefined;
}

/**
 * Flatten one Airbnb search result into a shallow object.
 *
 * The payload Airbnb ships is shaped for a React tree, not for a reader. A single
 * result spends most of its bytes on structure rather than information:
 *
 *   - `demandStayListing.id` is base64 of "DemandStayListing:<id>", so it restates
 *     the id we already extract
 *   - the listing name arrives at
 *     `demandStayListing.description.name.localizedStringWithTranslationPreference`,
 *     which costs more in key names than the name itself
 *   - `explanationData.title` is the constant string "Price details", repeated once
 *     per result
 *   - `mapSecondaryLine` and `secondaryLine` are usually empty strings
 *
 * None of that survives contact with a consumer, and for an MCP server the consumer
 * is a context window. Returns only keys that have a value, so absent fields cost
 * nothing rather than serializing as null.
 */
export function compactSearchResult(raw: any, baseUrl: string): any {
  if (!raw || typeof raw !== "object") return raw;

  const listing = raw.demandStayListing ?? {};
  const id = decodeListingId(listing.id);

  const coordinate = listing.location?.coordinate ?? {};
  const price = raw.structuredDisplayPrice ?? {};

  // priceDetails arrives with a trailing ", " from the array flattening upstream.
  const priceDetails =
    typeof price.explanationData?.priceDetails === "string"
      ? price.explanationData.priceDetails.replace(/,\s*$/, "")
      : undefined;

  const out: Record<string, any> = {
    id,
    url: id ? `${baseUrl}/rooms/${id}` : undefined,
    name: listing.description?.name?.localizedStringWithTranslationPreference,
    layout: raw.structuredContent?.primaryLine,
    badges: raw.badges,
    rating: raw.avgRatingA11yLabel,
    price: price.primaryLine?.accessibilityLabel,
    priceDetails,
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
  };

  for (const key of Object.keys(out)) {
    const v = out[key];
    if (v === undefined || v === null || v === "") delete out[key];
  }
  return out;
}

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

  const mapped = groups.map((group: any) => {
    const items = Array.isArray(group?.amenities) ? group.amenities : [];
    const label = (a: any) => {
      const sub = a?.subtitle?.text;
      return sub ? `${a.title} (${sub})` : a?.title;
    };
    const available = items.filter((a: any) => a?.available !== false).map(label).filter(Boolean);
    const unavailable = items.filter((a: any) => a?.available === false).map(label).filter(Boolean);
    return {
      title: group?.title,
      ...(available.length ? { available } : {}),
      ...(unavailable.length ? { unavailable } : {}),
    };
  });

  return {
    title: pdp?.amenities?.title ?? undefined,
    subtitle: pdp?.amenities?.subtitle ?? undefined,
    seeAllAmenitiesGroups: mapped,
  };
}

export function extractHighlights(pdp: any): any | null {
  const highlights = pdp?.highlights;
  if (!Array.isArray(highlights) || highlights.length === 0) return null;
  return {
    highlights: highlights
      .map((h: any) => {
        const sub = h?.subtitle;
        return sub ? `${h?.title}: ${sub}` : h?.title;
      })
      .filter(Boolean),
  };
}

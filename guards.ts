/**
 * Input validation, throttling and caching helpers.
 *
 * Kept free of network and MCP imports so they can be unit-tested offline.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function isValidIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  // Rejects overflow such as 2026-02-31, which Date would silently roll over.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function optionalDate(name: string, value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !isValidIsoDate(value)) {
    throw new ValidationError(`${name} must be a valid date formatted YYYY-MM-DD`);
  }
  return value;
}

function optionalCount(name: string, value: unknown, fallback: number, max = 50): number {
  if (value == null) return fallback;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) {
    throw new ValidationError(`${name} must be an integer between 0 and ${max}`);
  }
  return n;
}

function optionalPrice(name: string, value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new ValidationError(`${name} must be a non-negative number`);
  }
  return n;
}

function checkDateOrder(checkin?: string, checkout?: string) {
  if (checkout && !checkin) {
    throw new ValidationError("checkout was provided without checkin");
  }
  if (checkin && checkout && checkout <= checkin) {
    throw new ValidationError("checkout must be after checkin");
  }
}

const PROPERTY_TYPES = ["entire_home", "private_room", "shared_room", "hotel_room"] as const;

export interface SearchParams {
  location: string;
  placeId?: string;
  checkin?: string;
  checkout?: string;
  adults: number;
  children: number;
  infants: number;
  pets: number;
  minPrice?: number;
  maxPrice?: number;
  cursor?: string;
  propertyType?: (typeof PROPERTY_TYPES)[number];
  ignoreRobotsText: boolean;
}

export function validateSearchParams(raw: any): SearchParams {
  if (raw == null || typeof raw !== "object") {
    throw new ValidationError("Tool arguments must be an object");
  }
  if (typeof raw.location !== "string" || raw.location.trim() === "") {
    throw new ValidationError("location is required and must be a non-empty string");
  }
  if (raw.location.length > 200) {
    throw new ValidationError("location is too long (max 200 characters)");
  }

  const checkin = optionalDate("checkin", raw.checkin);
  const checkout = optionalDate("checkout", raw.checkout);
  checkDateOrder(checkin, checkout);

  const minPrice = optionalPrice("minPrice", raw.minPrice);
  const maxPrice = optionalPrice("maxPrice", raw.maxPrice);
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw new ValidationError("minPrice must not be greater than maxPrice");
  }

  if (raw.propertyType != null && !PROPERTY_TYPES.includes(raw.propertyType)) {
    throw new ValidationError(`propertyType must be one of: ${PROPERTY_TYPES.join(", ")}`);
  }

  return {
    location: raw.location.trim(),
    placeId: typeof raw.placeId === "string" && raw.placeId ? raw.placeId : undefined,
    checkin,
    checkout,
    adults: optionalCount("adults", raw.adults, 1),
    children: optionalCount("children", raw.children, 0),
    infants: optionalCount("infants", raw.infants, 0),
    pets: optionalCount("pets", raw.pets, 0),
    minPrice,
    maxPrice,
    cursor: typeof raw.cursor === "string" && raw.cursor ? raw.cursor : undefined,
    propertyType: raw.propertyType ?? undefined,
    ignoreRobotsText: raw.ignoreRobotsText === true,
  };
}

export interface ListingParams {
  id: string;
  checkin?: string;
  checkout?: string;
  adults: number;
  children: number;
  infants: number;
  pets: number;
  ignoreRobotsText: boolean;
}

export function validateListingParams(raw: any): ListingParams {
  if (raw == null || typeof raw !== "object") {
    throw new ValidationError("Tool arguments must be an object");
  }
  const id = typeof raw.id === "number" ? String(raw.id) : raw.id;
  // The id ends up in a URL path, so only digits are accepted.
  if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) {
    throw new ValidationError("id is required and must be a numeric Airbnb listing ID");
  }

  const checkin = optionalDate("checkin", raw.checkin);
  const checkout = optionalDate("checkout", raw.checkout);
  checkDateOrder(checkin, checkout);

  return {
    id,
    checkin,
    checkout,
    adults: optionalCount("adults", raw.adults, 1),
    children: optionalCount("children", raw.children, 0),
    infants: optionalCount("infants", raw.infants, 0),
    pets: optionalCount("pets", raw.pets, 0),
    ignoreRobotsText: raw.ignoreRobotsText === true,
  };
}

/**
 * Serialises calls so that two consecutive ones start at least `minIntervalMs` apart.
 * Nominatim's usage policy asks for at most one request per second; the same helper
 * keeps requests to Airbnb polite when an agent fires several searches in a row.
 */
export class Throttle {
  private nextSlot = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async wait(): Promise<void> {
    const t = this.now();
    const start = Math.max(t, this.nextSlot);
    // Reserve the slot before sleeping so concurrent callers queue up behind each other.
    this.nextSlot = start + this.minIntervalMs;
    const delay = start - t;
    if (delay > 0) await this.sleep(delay);
  }
}

/** Small in-memory TTL cache with a size bound (oldest entry evicted first). */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.store.delete(key);
    this.store.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  get size(): number {
    return this.store.size;
  }
}

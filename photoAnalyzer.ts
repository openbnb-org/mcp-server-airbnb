import fetch from "node-fetch";
import * as cheerio from "cheerio";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface ListingPhoto {
  url: string;
  caption?: string;
  accessibilityLabel?: string;
}

export interface ExtractedPhotos {
  listingId: string;
  photos: ListingPhoto[];
  photoUrls: string[];
  photoCount: number;
  extractionSuccess: boolean;
  error?: string;
  timestamp: string;
}

function collectPhotos(node: any, out: Map<string, ListingPhoto>) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectPhotos(item, out);
    return;
  }

  const url: string | undefined =
    typeof node.baseUrl === "string"
      ? node.baseUrl
      : typeof node.url === "string" && /muscache\.com/.test(node.url)
      ? node.url
      : undefined;

  const looksLikePhoto =
    url &&
    (node.__typename === "Image" ||
      node.__typename === "Picture" ||
      node.accessibilityLabel ||
      node.caption ||
      /muscache\.com\/im\/pictures|muscache\.com\/pictures/.test(url));

  if (url && looksLikePhoto && !out.has(url)) {
    out.set(url, {
      url,
      caption: typeof node.caption === "string" ? node.caption : undefined,
      accessibilityLabel:
        typeof node.accessibilityLabel === "string"
          ? node.accessibilityLabel
          : undefined,
    });
  }

  for (const key of Object.keys(node)) collectPhotos(node[key], out);
}

export async function extractListingPhotos(
  listingId: string
): Promise<ExtractedPhotos> {
  const timestamp = new Date().toISOString();
  try {
    const url = `https://www.airbnb.com/rooms/${encodeURIComponent(listingId)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const photoMap = new Map<string, ListingPhoto>();

    const scriptContent = $("#data-deferred-state-0").first().text();
    if (scriptContent) {
      try {
        const parsed = JSON.parse(scriptContent);
        collectPhotos(parsed, photoMap);
      } catch {
        // fall through to fallback below
      }
    }

    if (photoMap.size === 0) {
      $('img').each((_: any, el: any) => {
        const src = $(el).attr("src") || $(el).attr("data-original-uri") || "";
        if (src && /muscache\.com\/(im\/)?pictures/.test(src)) {
          if (!photoMap.has(src)) {
            photoMap.set(src, {
              url: src,
              accessibilityLabel: $(el).attr("alt") || undefined,
            });
          }
        }
      });
    }

    const photos = Array.from(photoMap.values()).slice(0, 50);

    return {
      listingId,
      photos,
      photoUrls: photos.map((p) => p.url),
      photoCount: photos.length,
      extractionSuccess: photos.length > 0,
      timestamp,
    };
  } catch (error) {
    return {
      listingId,
      photos: [],
      photoUrls: [],
      photoCount: 0,
      extractionSuccess: false,
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp,
    };
  }
}

export function formatPhotosForAnalysis(photos: ExtractedPhotos): string {
  if (!photos.photoCount) {
    return `Listing ${photos.listingId}: no photos extracted.`;
  }
  const lines = photos.photos.map((p, i) => {
    const label = p.accessibilityLabel || p.caption || "";
    return label ? `Photo ${i + 1}: ${p.url} — ${label}` : `Photo ${i + 1}: ${p.url}`;
  });
  return `Listing ${photos.listingId} (${photos.photoCount} photos)\n${lines.join("\n")}`;
}

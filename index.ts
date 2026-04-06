#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { cleanObject, flattenArraysInObject, pickBySchema, diagnoseJsonPath } from "./util.js";
import robotsParser from "robots-parser";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    return process.env.MCP_SERVER_VERSION || packageJson.version || "unknown";
  } catch (error) {
    return process.env.MCP_SERVER_VERSION || "unknown";
  }
}

const VERSION = getVersion();

// Tool definitions
const AIRBNB_SEARCH_TOOL: Tool = {
  name: "airbnb_search",
  description: "Search for Airbnb listings with various filters and pagination. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "Location to search for (city, state, etc.)"
      },
      placeId: {
        type: "string",
        description: "Google Maps Place ID (overrides the location parameter)"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      minPrice: {
        type: "number",
        description: "Minimum price for the stay"
      },
      maxPrice: {
        type: "number",
        description: "Maximum price for the stay"
      },
      cursor: {
        type: "string",
        description: "Base64-encoded string used for Pagination"
      },
      propertyType: {
        type: "string",
        enum: ["entire_home", "private_room", "shared_room", "hotel_room"],
        description: "Filter by property type: 'entire_home' (entire homes/apartments), 'private_room' (private rooms in shared homes), 'shared_room' (shared/dorm-style rooms), 'hotel_room' (hotel rooms)"
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      }
    },
    required: ["location"]
  }
};

const AIRBNB_LISTING_DETAILS_TOOL: Tool = {
  name: "airbnb_listing_details",
  description: "Get detailed information about a specific Airbnb listing. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The Airbnb listing ID"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      }
    },
    required: ["id"]
  }
};

const AIRBNB_TOOLS = [
  AIRBNB_SEARCH_TOOL,
  AIRBNB_LISTING_DETAILS_TOOL,
] as const;

// Utility functions
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://www.airbnb.com";

// Geocode location using Photon (fast, no rate limits) with Nominatim fallback.
// This bypasses Airbnb's broken server-side geocoding for non-US locations.
// Photon doesn't rank by importance, so we fetch multiple results and prefer
// cities/states/countries over hamlets/houses/POIs.
const PHOTON_TYPE_PRIORITY: Record<string, number> = {
  country: 1, state: 2, county: 3, city: 4, district: 5,
  locality: 6, street: 7, house: 8, other: 9,
};

function pickBestPhotonFeature(features: any[]): any | null {
  // Pick the feature with the highest-priority type (city > hamlet > house etc).
  // Don't filter by extent here — the best match (e.g. Stockholm, Sweden) may
  // lack an extent, and we'll fall back to Nominatim for the bbox.
  if (!features || features.length === 0) return null;

  return features.reduce((best: any, f: any) => {
    const bestPri = PHOTON_TYPE_PRIORITY[best.properties?.type] ?? PHOTON_TYPE_PRIORITY.other;
    const fPri = PHOTON_TYPE_PRIORITY[f.properties?.type] ?? PHOTON_TYPE_PRIORITY.other;
    return fPri < bestPri ? f : best;
  });
}

async function geocodeLocation(location: string): Promise<{
  ne_lat: string; ne_lng: string; sw_lat: string; sw_lng: string;
  displayName: string;
} | null> {
  let extent: number[] | null = null;
  let displayName = location;

  // Try Photon first — fast, no strict rate limits, OSM data.
  try {
    log('info', 'Geocoding location via Photon', { location });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=5`;
    let response;
    try {
      response = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      const data = await response.json() as any;
      const feature = pickBestPhotonFeature(data?.features ?? []);
      if (feature) {
        if (feature.properties?.extent?.length === 4) {
          extent = feature.properties.extent; // [west_lng, north_lat, east_lng, south_lat]
        }
        displayName = feature.properties?.name || location;
        log('info', 'Photon selected feature', {
          location,
          type: feature.properties?.type,
          name: feature.properties?.name,
          country: feature.properties?.country,
          hasExtent: !!extent,
        });
      }
    }
  } catch (error) {
    log('warn', 'Photon geocoding failed', {
      location,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fall back to Nominatim if Photon didn't return a bbox.
  // Nominatim ranks by importance so it handles ambiguous names well.
  // Nominatim usage policy requires an identifying User-Agent (not a browser UA).
  // See https://operations.osmfoundation.org/policies/nominatim/
  if (!extent) {
    try {
      log('info', 'Falling back to Nominatim for geocoding', { location });
      const nomController = new AbortController();
      const nomTimeout = setTimeout(() => nomController.abort(), 5000);
      const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
      let nomResponse;
      try {
        nomResponse = await fetch(nomUrl, {
          headers: {
            "User-Agent": "MCP-Airbnb-Server/1.0 (geocoding-fallback)",
            "Accept": "application/json",
          },
          signal: nomController.signal,
        });
      } finally {
        clearTimeout(nomTimeout);
      }
      if (nomResponse.ok) {
        const nomResults = await nomResponse.json() as any[];
        if (nomResults?.[0]?.boundingbox?.length === 4) {
          const bb = nomResults[0].boundingbox; // [south_lat, north_lat, west_lng, east_lng]
          extent = [parseFloat(bb[2]), parseFloat(bb[1]), parseFloat(bb[3]), parseFloat(bb[0])];
          displayName = nomResults[0].display_name?.split(",")?.[0] || location;
          log('info', 'Nominatim fallback succeeded', { location, extent });
        }
      }
    } catch (nomError) {
      log('warn', 'Nominatim fallback also failed', { location });
    }
  }

  if (!extent || extent.length !== 4) {
    log('warn', 'No bounding box from either geocoder', { location });
    return null;
  }

  // Expand bounding box by 25% in each direction (minimum 0.1°, ~11km)
  // to capture suburbs, beaches, and surrounding areas. OSM returns tight
  // administrative boundaries (e.g., Paris = just the arrondissements,
  // Pensacola = city limits without the beach on the barrier island).
  const swLat = extent[3];
  const neLat = extent[1];
  const swLng = extent[0];
  const neLng = extent[2];
  const latPadding = Math.max((neLat - swLat) * 0.25, 0.1);
  const lngPadding = Math.max((neLng - swLng) * 0.25, 0.1);

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const coords = {
    sw_lat: clamp(swLat - latPadding, -90, 90).toFixed(7),
    ne_lat: clamp(neLat + latPadding, -90, 90).toFixed(7),
    sw_lng: clamp(swLng - lngPadding, -180, 180).toFixed(7),
    ne_lng: clamp(neLng + lngPadding, -180, 180).toFixed(7),
    displayName,
  };

  log('info', 'Geocoded successfully (with 25% padding)', { location, coords });
  return coords;
}

const PROPERTY_TYPE_IDS: Record<string, string> = {
  entire_home:  "1",
  private_room: "2",
  shared_room:  "3",
  hotel_room:   "4",
};

// Configuration from environment variables (set by DXT host)
const IGNORE_ROBOTS_TXT = process.env.IGNORE_ROBOTS_TXT === "true" || process.argv.slice(2).includes("--ignore-robots-txt");

const robotsErrorMessage = "This path is disallowed by Airbnb's robots.txt to this User-agent. You may or may not want to run the server with '--ignore-robots-txt' args"
let robotsTxtContent = "";

// Enhanced robots.txt fetch with timeout and error handling
async function fetchRobotsTxt() {
  if (IGNORE_ROBOTS_TXT) {
    log('info', 'Skipping robots.txt fetch (ignored by configuration)');
    return;
  }

  try {
    log('info', 'Fetching robots.txt from Airbnb');
    
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(`${BASE_URL}/robots.txt`, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    robotsTxtContent = await response.text();
    log('info', 'Successfully fetched robots.txt');
  } catch (error) {
    log('warn', 'Error fetching robots.txt, assuming all paths allowed', {
      error: error instanceof Error ? error.message : String(error)
    });
    robotsTxtContent = ""; // Empty robots.txt means everything is allowed
  }
}

function isPathAllowed(path: string): boolean {  
  if (!robotsTxtContent) {
    return true; // If we couldn't fetch robots.txt, assume allowed
  }

  try {
    const robots = robotsParser(`${BASE_URL}/robots.txt`, robotsTxtContent);
    const allowed = robots.isAllowed(path, USER_AGENT);
    
    if (!allowed) {
      log('warn', 'Path disallowed by robots.txt', { path, userAgent: USER_AGENT });
    }
    
    return allowed;
  } catch (error) {
    log('warn', 'Error parsing robots.txt, allowing path', {
      path,
      error: error instanceof Error ? error.message : String(error)
    });
    return true; // If parsing fails, be permissive
  }
}

async function fetchWithUserAgent(url: string, timeout: number = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    
    throw error;
  }
}

// API handlers
async function handleAirbnbSearch(params: any) {
  const {
    location,
    placeId,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    minPrice,
    maxPrice,
    cursor,
    propertyType,
    ignoreRobotsText = false,
  } = params;

  // Build search URL
  const searchUrl = new URL(`${BASE_URL}/s/${encodeURIComponent(location)}/homes`);
  
  // Add placeId
  if (placeId) searchUrl.searchParams.append("place_id", placeId);
  
  // Geocode and add bounding box to fix broken server-side geocoding
  if (!placeId) {
    const coords = await geocodeLocation(location);
    if (coords) {
      searchUrl.searchParams.append("ne_lat", coords.ne_lat);
      searchUrl.searchParams.append("ne_lng", coords.ne_lng);
      searchUrl.searchParams.append("sw_lat", coords.sw_lat);
      searchUrl.searchParams.append("sw_lng", coords.sw_lng);
    }
  }
  
  // Add query parameters
  if (checkin) searchUrl.searchParams.append("checkin", checkin);
  if (checkout) searchUrl.searchParams.append("checkout", checkout);
  
  // Add guests
  const adults_int = parseInt(adults.toString());
  const children_int = parseInt(children.toString());
  const infants_int = parseInt(infants.toString());
  const pets_int = parseInt(pets.toString());
  
  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    searchUrl.searchParams.append("adults", adults_int.toString());
    searchUrl.searchParams.append("children", children_int.toString());
    searchUrl.searchParams.append("infants", infants_int.toString());
    searchUrl.searchParams.append("pets", pets_int.toString());
  }
  
  // Add price range
  if (minPrice != null) searchUrl.searchParams.append("price_min", minPrice.toString());
  if (maxPrice != null) searchUrl.searchParams.append("price_max", maxPrice.toString());
  
  // Add property type filter
  if (propertyType && PROPERTY_TYPE_IDS[propertyType]) {
    searchUrl.searchParams.append("l2_property_type_ids[]", PROPERTY_TYPE_IDS[propertyType]);
  }

  // Add cursor for pagination
  if (cursor) {
    searchUrl.searchParams.append("cursor", cursor);
  }

  // Check if path is allowed by robots.txt
  const path = searchUrl.pathname + searchUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Search blocked by robots.txt', { path, url: searchUrl.toString() });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: searchUrl.toString(),
          suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing"
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSearchResultSchema: Record<string, any> = {
    demandStayListing : {
      id: true,
      description: true,
      location: true,
    },
    badges: {
      text: true,
    },
    structuredContent: {
      mapCategoryInfo: {
        body: true
      },
      mapSecondaryLine: {
        body: true
      },
      primaryLine: {
        body: true
      },
      secondaryLine: {
        body: true
      },
    },
    avgRatingA11yLabel: true,
    listingParamOverrides: true,
    structuredDisplayPrice: {
      primaryLine: {
        accessibilityLabel: true,
      },
      secondaryLine: {
        accessibilityLabel: true,
      },
      explanationData: {
        title: true,
        priceDetails: {
          items: {
            description: true,
            priceString: true
          }
        }
      }
    },
    // contextualPictures: {
    //   picture: true
    // }
  };

  try {
    log('info', 'Performing Airbnb search', { location, checkin, checkout, adults, children });
    
    const response = await fetchWithUserAgent(searchUrl.toString());
    const html = await response.text();
    const $ = cheerio.load(html);
    
    let staysSearchResults: any = {};
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const results = clientData.niobeClientData[0][1].data.presentation.staysSearch.results;
      cleanObject(results);
      
      staysSearchResults = {
        searchResults: results.searchResults
          .map((result: any) => flattenArraysInObject(pickBySchema(result, allowSearchResultSchema)))
          .map((result: any) => {
            const id = atob(result.demandStayListing.id).split(":")[1];
            return {id, url: `${BASE_URL}/rooms/${id}`, ...result }
          }),
        paginationInfo: results.paginationInfo
      }
      
      log('info', 'Search completed successfully', { 
        resultCount: staysSearchResults.searchResults?.length || 0 
      });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const searchPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'staysSearch', 'results'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, searchPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse search results', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        diagnosis,
        url: searchUrl.toString()
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse search results from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            searchUrl: searchUrl.toString()
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          searchUrl: searchUrl.toString(),
          ...staysSearchResults
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Search request failed', {
      error: error instanceof Error ? error.message : String(error),
      url: searchUrl.toString()
    });
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          searchUrl: searchUrl.toString(),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

async function handleAirbnbListingDetails(params: any) {
  const {
    id,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    ignoreRobotsText = false,
  } = params;

  // Build listing URL
  const listingUrl = new URL(`${BASE_URL}/rooms/${id}`);
  
  // Add query parameters
  if (checkin) listingUrl.searchParams.append("check_in", checkin);
  if (checkout) listingUrl.searchParams.append("check_out", checkout);
  
  // Add guests
  const adults_int = parseInt(adults.toString());
  const children_int = parseInt(children.toString());
  const infants_int = parseInt(infants.toString());
  const pets_int = parseInt(pets.toString());
  
  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    listingUrl.searchParams.append("adults", adults_int.toString());
    listingUrl.searchParams.append("children", children_int.toString());
    listingUrl.searchParams.append("infants", infants_int.toString());
    listingUrl.searchParams.append("pets", pets_int.toString());
  }

  // Check if path is allowed by robots.txt
  const path = listingUrl.pathname + listingUrl.search;
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Listing details blocked by robots.txt', { path, url: listingUrl.toString() });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: robotsErrorMessage,
          url: listingUrl.toString(),
          suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing"
        }, null, 2)
      }],
      isError: true
    };
  }

  const allowSectionSchema: Record<string, any> = {
    "LOCATION_DEFAULT": {
      lat: true,
      lng: true,
      subtitle: true,
      title: true
    },
    "POLICIES_DEFAULT": {
      title: true,
      houseRulesSections: {
        title: true,
        items : {
          title: true
        }
      }
    },
    "HIGHLIGHTS_DEFAULT": {
      highlights: {
        title: true
      }
    },
    "DESCRIPTION_DEFAULT": {
      htmlDescription: {
        htmlText: true
      }
    },
    "AMENITIES_DEFAULT": {
      title: true,
      seeAllAmenitiesGroups: {
        title: true,
        amenities: {
          title: true
        }
      }
    },
    //"AVAILABLITY_CALENDAR_DEFAULT": true,
  };

  try {
    log('info', 'Fetching listing details', { id, checkin, checkout, adults, children });
    
    const response = await fetchWithUserAgent(listingUrl.toString());
    const html = await response.text();
    const $ = cheerio.load(html);
    
    let details = {};
    let scriptContent = '';
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent);
      const sections = clientData.niobeClientData[0][1].data.presentation.stayProductDetailPage.sections.sections;
      sections.forEach((section: any) => cleanObject(section));
      
      details = sections
        .filter((section: any) => allowSectionSchema.hasOwnProperty(section.sectionId))
        .map((section: any) => {
          return {
            id: section.sectionId,
            ...flattenArraysInObject(pickBySchema(section.section, allowSectionSchema[section.sectionId]))
          }
        });
        
      log('info', 'Listing details fetched successfully', { 
        id, 
        sectionsFound: Array.isArray(details) ? details.length : 0 
      });
    } catch (parseError) {
      let parsedRaw: any = null;
      try { parsedRaw = JSON.parse(scriptContent); } catch (_) {}
      const detailsPath = ['niobeClientData', '0', '1', 'data', 'presentation', 'stayProductDetailPage', 'sections', 'sections'];
      const diagnosis = parsedRaw ? diagnoseJsonPath(parsedRaw, detailsPath) : 'Could not parse script content as JSON';

      log('error', 'Failed to parse listing details', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        diagnosis,
        id,
        url: listingUrl.toString()
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse listing details from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            diagnosis,
            listingUrl: listingUrl.toString()
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          listingUrl: listingUrl.toString(),
          details: details
        }, null, 2)
      }],
      isError: false
    };
  } catch (error) {
    log('error', 'Listing details request failed', {
      error: error instanceof Error ? error.message : String(error),
      id,
      url: listingUrl.toString()
    });
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          listingUrl: listingUrl.toString(),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
}

// Server setup
const server = new Server(
  {
    name: "airbnb",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Enhanced logging for DXT
function log(level: 'info' | 'warn' | 'error', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (data) {
    console.error(`${logMessage}:`, JSON.stringify(data, null, 2));
  } else {
    console.error(logMessage);
  }
}

log('info', 'Airbnb MCP Server starting', {
  version: VERSION,
  ignoreRobotsTxt: IGNORE_ROBOTS_TXT,
  nodeVersion: process.version,
  platform: process.platform
});

// Set up request handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AIRBNB_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  
  try {
    // Validate request parameters
    if (!request.params.name) {
      throw new McpError(ErrorCode.InvalidParams, "Tool name is required");
    }
    
    if (!request.params.arguments) {
      throw new McpError(ErrorCode.InvalidParams, "Tool arguments are required");
    }
    
    log('info', 'Tool call received', { 
      tool: request.params.name,
      arguments: request.params.arguments 
    });
    
    // Ensure robots.txt is loaded
    if (!robotsTxtContent && !IGNORE_ROBOTS_TXT) {
      await fetchRobotsTxt();
    }

    let result;
    switch (request.params.name) {
      case "airbnb_search": {
        result = await handleAirbnbSearch(request.params.arguments);
        break;
      }

      case "airbnb_listing_details": {
        result = await handleAirbnbListingDetails(request.params.arguments);
        break;
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
    }
    
    const duration = Date.now() - startTime;
    log('info', 'Tool call completed', { 
      tool: request.params.name, 
      duration: `${duration}ms`,
      success: !result.isError 
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    log('error', 'Tool call failed', {
      tool: request.params.name,
      duration: `${duration}ms`,
      error: error instanceof Error ? error.message : String(error)
    });
    
    if (error instanceof McpError) {
      throw error;
    }
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString()
        }, null, 2)
      }],
      isError: true
    };
  }
});

async function runServer() {
  try {
    // Initialize robots.txt on startup
    await fetchRobotsTxt();
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    log('info', 'Airbnb MCP Server running on stdio', {
      version: VERSION,
      robotsRespected: !IGNORE_ROBOTS_TXT
    });
    
    // Graceful shutdown handling
    process.on('SIGINT', () => {
      log('info', 'Received SIGINT, shutting down gracefully');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      log('info', 'Received SIGTERM, shutting down gracefully');
      process.exit(0);
    });
    
  } catch (error) {
    log('error', 'Failed to start server', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

runServer().catch((error) => {
  log('error', 'Fatal error running server', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});

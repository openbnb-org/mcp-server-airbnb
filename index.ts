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
import { cleanObject, flattenArraysInObject, pickBySchema } from "./util.js";
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
      amenities: {
        type: "array",
        items: { type: "number" },
        description: "List of required amenity IDs. Common IDs: wifi=4, air_conditioning=5, kitchen=8, free_parking=9, washer=33, dryer=34, pool=7, hot_tub=25, ev_charger=97, tv=58, heating=30, dedicated_workspace=47, hair_dryer=45, iron=46, crib=286, king_bed=1000, gym=15, bbq_grill=99, breakfast=16, indoor_fireplace=27, smoking_allowed=11, self_checkin=51, smoke_alarm=35, co_alarm=36"
      },
      roomType: {
        type: "string",
        enum: ["entire_home", "private_room", "hotel_room"],
        description: "Type of place: 'entire_home' (whole home/apt), 'private_room', or 'hotel_room'"
      },
      propertyTypes: {
        type: "array",
        items: { type: "string", enum: ["house", "apartment", "guesthouse", "hotel"] },
        description: "Filter by property type(s): 'house', 'apartment', 'guesthouse', 'hotel'"
      },
      minBedrooms: {
        type: "number",
        description: "Minimum number of bedrooms"
      },
      minBeds: {
        type: "number",
        description: "Minimum number of beds"
      },
      minBathrooms: {
        type: "number",
        description: "Minimum number of bathrooms"
      },
      instantBook: {
        type: "boolean",
        description: "Only show listings with Instant Book enabled"
      },
      selfCheckIn: {
        type: "boolean",
        description: "Only show listings with self check-in"
      },
      freeCancellation: {
        type: "boolean",
        description: "Only show listings with free cancellation"
      },
      cursor: {
        type: "string",
        description: "Base64-encoded string used for Pagination"
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

// Amenity name → numeric ID mapping (sourced from Airbnb filter UI)
const AMENITY_IDS: Record<string, number> = {
  'wifi': 4,
  'air conditioning': 5,
  'ac': 5,
  'kitchen': 8,
  'free parking': 9,
  'parking': 9,
  'pool': 7,
  'hot tub': 25,
  'jacuzzi': 25,
  'ev charger': 97,
  'tv': 58,
  'washer': 33,
  'dryer': 34,
  'heating': 30,
  'dedicated workspace': 47,
  'workspace': 47,
  'hair dryer': 45,
  'iron': 46,
  'crib': 286,
  'king bed': 1000,
  'gym': 15,
  'bbq grill': 99,
  'bbq': 99,
  'grill': 99,
  'breakfast': 16,
  'indoor fireplace': 27,
  'fireplace': 27,
  'smoking allowed': 11,
  'self check-in': 51,
  'self checkin': 51,
  'smoke alarm': 35,
  'carbon monoxide alarm': 36,
};

// Property type name → l2_property_type_id
const PROPERTY_TYPE_IDS: Record<string, number> = {
  'house': 1,
  'guesthouse': 2,
  'apartment': 3,
};

// Utility functions
const USER_AGENT = "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)";
const BASE_URL = "https://www.airbnb.com";

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
    amenities,
    roomType,
    propertyTypes,
    minBedrooms,
    minBeds,
    minBathrooms,
    instantBook,
    selfCheckIn,
    freeCancellation,
    cursor,
    ignoreRobotsText = false,
  } = params;

  // Build search URL
  const searchUrl = new URL(`${BASE_URL}/s/${encodeURIComponent(location)}/homes`);
  
  // Add placeId
  if (placeId) searchUrl.searchParams.append("place_id", placeId);
  
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
  if (minPrice) searchUrl.searchParams.append("price_min", minPrice.toString());
  if (maxPrice) searchUrl.searchParams.append("price_max", maxPrice.toString());

  // Add amenities filter
  if (amenities && Array.isArray(amenities)) {
    const addedIds = new Set<number>();
    for (const amenity of amenities) {
      let id: number | undefined;
      if (typeof amenity === 'number') {
        id = amenity;
      } else {
        id = AMENITY_IDS[String(amenity).toLowerCase().trim()];
      }
      if (id !== undefined && !addedIds.has(id)) {
        searchUrl.searchParams.append("amenities[]", id.toString());
        addedIds.add(id);
      }
    }
  }

  // Add self check-in as amenity (ID 51)
  if (selfCheckIn) {
    searchUrl.searchParams.append("amenities[]", "51");
  }

  // Add room type filter (type of place)
  if (roomType) {
    const roomTypeLower = roomType.toLowerCase().replace(/_/g, ' ');
    if (roomTypeLower === 'entire home' || roomTypeLower === 'entire_home') {
      searchUrl.searchParams.append("room_types[]", "Entire home/apt");
    } else if (roomTypeLower === 'private room' || roomTypeLower === 'private_room') {
      searchUrl.searchParams.append("room_types[]", "Private room");
    } else if (roomTypeLower === 'hotel room' || roomTypeLower === 'hotel_room') {
      searchUrl.searchParams.append("kg_and_tags[]", "Tag:9613");
    }
  }

  // Add property type filter
  if (propertyTypes && Array.isArray(propertyTypes)) {
    for (const propType of propertyTypes) {
      const lower = propType.toLowerCase().trim();
      const id = PROPERTY_TYPE_IDS[lower];
      if (id !== undefined) {
        searchUrl.searchParams.append("l2_property_type_ids[]", id.toString());
      } else if (lower === 'hotel') {
        searchUrl.searchParams.append("kg_and_tags[]", "Tag:9613");
      }
    }
  }

  // Add rooms and beds filters
  if (minBedrooms) searchUrl.searchParams.append("min_bedrooms", parseInt(minBedrooms.toString()).toString());
  if (minBeds) searchUrl.searchParams.append("min_beds", parseInt(minBeds.toString()).toString());
  if (minBathrooms) searchUrl.searchParams.append("min_bathrooms", parseInt(minBathrooms.toString()).toString());

  // Add booking option filters
  if (instantBook) searchUrl.searchParams.append("ib", "true");
  if (freeCancellation) searchUrl.searchParams.append("flexible_cancellation", "true");

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
      loggingContext: {
        badgeType: true,
      },
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
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      const scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent).niobeClientData[0][1];
      const results = clientData.data.presentation.staysSearch.results;
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
      log('error', 'Failed to parse search results', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        url: searchUrl.toString()
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse search results from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
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
    "MEET_YOUR_HOST": {
      cardData: {
        name: true,
        titleText: true,
        isSuperhost: true,
        isVerified: true,
        stats: {
          label: true,
          value: true
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
    
    try {
      const scriptElement = $("#data-deferred-state-0").first();
      if (scriptElement.length === 0) {
        throw new Error("Could not find data script element - page structure may have changed");
      }
      
      const scriptContent = $(scriptElement).text();
      if (!scriptContent) {
        throw new Error("Data script element is empty");
      }
      
      const clientData = JSON.parse(scriptContent).niobeClientData[0][1];
      const sections = clientData.data.presentation.stayProductDetailPage.sections.sections;
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
      log('error', 'Failed to parse listing details', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        id,
        url: listingUrl.toString()
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Failed to parse listing details from Airbnb. The page structure may have changed.",
            details: parseError instanceof Error ? parseError.message : String(parseError),
            listingUrl: listingUrl.toString()
          }, null, 2)
        }],
        isError: true
      };
    }

    // Fetch full photo gallery with categories (non-fatal if unavailable)
    try {
      const modalUrl = new URL(listingUrl.toString());
      modalUrl.searchParams.set('modal', 'PHOTO_TOUR_SCROLLABLE');

      const modalResponse = await fetchWithUserAgent(modalUrl.toString());
      const modalHtml = await modalResponse.text();
      const $modal = cheerio.load(modalHtml);

      const modalScript = $modal('#data-deferred-state-0').first().text();
      const modalSections = JSON.parse(modalScript).niobeClientData[0][1]
        .data.presentation.stayProductDetailPage.sections.sections;

      const photoSection = modalSections.find((s: any) => s.sectionId === 'PHOTO_TOUR_SCROLLABLE_MODAL');

      if (photoSection?.section) {
        const { mediaItems, roomTourLayoutInfos } = photoSection.section;

        // Build id → { url, label } lookup
        const mediaMap: Record<string, { url: string; label: string }> = {};
        for (const item of (mediaItems || [])) {
          if (item.id && item.baseUrl) {
            mediaMap[item.id] = { url: item.baseUrl, label: item.accessibilityLabel || '' };
          }
        }

        // Build categorised groups from roomTourLayoutInfos
        const roomTourItems = roomTourLayoutInfos?.[0]?.roomTourItems || [];
        const categories: Array<{ title: string; photos: Array<{ url: string; label: string }> }> = [];
        const categorisedIds = new Set<string>();

        for (const group of roomTourItems) {
          const photos = (group.imageIds || [])
            .map((imgId: string) => mediaMap[imgId])
            .filter(Boolean);
          if (photos.length > 0) {
            photos.forEach((_: any, i: number) => categorisedIds.add((group.imageIds || [])[i]));
            categories.push({ title: group.title, photos });
          }
        }

        // Append any photos not covered by a category
        const uncategorised = Object.entries(mediaMap)
          .filter(([imgId]) => !categorisedIds.has(imgId))
          .map(([, v]) => v);
        if (uncategorised.length > 0) {
          categories.push({ title: 'Other', photos: uncategorised });
        }

        (details as any[]).push({ id: 'PHOTO_TOUR', categories });
        log('info', 'Photo gallery fetched successfully', {
          id,
          totalPhotos: Object.keys(mediaMap).length,
          categories: categories.map(c => `${c.title} (${c.photos.length})`),
        });
      }
    } catch (photoError) {
      log('warn', 'Failed to fetch photo gallery (non-fatal)', {
        error: photoError instanceof Error ? photoError.message : String(photoError),
        id,
      });
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

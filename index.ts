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
import { Buffer } from "buffer";

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

const AIRBNB_LISTING_REVIEWS_TOOL: Tool = {
  name: "airbnb_listing_reviews",
  description: "Fetch public Airbnb listing reviews, including reviewer name, date, rating, and comments.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The Airbnb listing ID (numeric ID from the listing URL)."
      },
      apiKey: {
        type: "string",
        description: "Required Airbnb API key for authentication."
      },
      checkin: {
        type: "string",
        description: "Optional check-in date (YYYY-MM-DD). Used for context only."
      },
      checkout: {
        type: "string",
        description: "Optional check-out date (YYYY-MM-DD). Used for context only."
      },
      adults: {
        type: "number",
        description: "Number of adults (used for context in the request)."
      },
      children: {
        type: "number",
        description: "Number of children (used for context in the request)."
      },
      infants: {
        type: "number",
        description: "Number of infants (used for context in the request)."
      },
      pets: {
        type: "number",
        description: "Number of pets (used for context in the request)."
      },
      pages: {
        type: "number",
        description: "Number of review pages to fetch (24 reviews per page, default 1)."
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request."
      }
    },
    required: ["id", "apiKey"]
  }
};


const AIRBNB_TOOLS = [
  AIRBNB_SEARCH_TOOL,
  AIRBNB_LISTING_DETAILS_TOOL,
  AIRBNB_LISTING_REVIEWS_TOOL,
] as const;

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
    const headers = {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Cache-Control": "no-cache",
    };

    // Log curl command
    log('info', 'Request details', {
      curl: `curl -X GET '${url}' \\\n` +
        Object.entries(headers)
          .map(([key, value]) => `  -H '${key}: ${value}'`)
          .join(' \\\n')
    });

    const response = await fetch(url, {
      headers,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    // Log full response details
    log('info', 'Response details', {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      url: response.url
    });

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

  // Add room type
  // if (roomType) {
  //   const roomTypeParam = roomType.toLowerCase().replace(/\s+/g, '_');
  //   searchUrl.searchParams.append("room_types[]", roomTypeParam);
  // }

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
    demandStayListing: {
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
            return { id, url: `${BASE_URL}/rooms/${id}`, ...result }
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
        items: {
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
  };

  try {
    log('info', 'Fetching listing details', { id, checkin, checkout, adults, children });

    const response = await fetchWithUserAgent(listingUrl.toString());
    const html = await response.text();
    const $ = cheerio.load(html);

    let details = {};
    let apiKey = '';

    try {
      // Extract API key from data-injector-instances script
      const injectorScript = $("#data-initializer-bootstrap").first();
      if (injectorScript.length > 0) {
        const injectorContent = $(injectorScript).text();
        if (injectorContent) {
          try {
            const parsedData = JSON.parse(injectorContent);
            if (parsedData['layout-init']?.api_config?.key) {
              apiKey = parsedData['layout-init'].api_config.key;
            }
          } catch (e) {
            log('warn', 'Failed to parse API key from initializer script', {
              error: e instanceof Error ? e.message : String(e)
            });
          }
        }
      }

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
        sectionsFound: Array.isArray(details) ? details.length : 0,
        apiKey
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

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          listingUrl: listingUrl.toString(),
          details: details,
          apiKey
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

async function handleAirbnbListingReviews(params: any) {
  const {
    id,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    pages = 1,
    ignoreRobotsText = false,
    apiKey,
  } = params;

  const baseGraphQLUrl =
    "https://www.airbnb.com/api/v3/StaysPdpReviewsQuery/cc333abde7dc5d02628cfbde5dd3ba3b7a4f64c289dd6eccb39eb2b8f735b5fc";
  const path = `/api/v3/StaysPdpReviewsQuery`;

  // Check robots.txt permission
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    log("warn", "Reviews fetch blocked by robots.txt", { path });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: robotsErrorMessage,
              suggestion:
                "Enable 'ignore_robots_txt' in extension settings if needed for testing",
              path,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  try {
    log("info", "Fetching Airbnb reviews", { id, pages });

    const encodedId = Buffer.from(`StayListing:${id}`).toString("base64");
    const allReviews: any[] = [];

    for (let page = 0; page < pages; page++) {
      const limit = 24;
      const offset = (page * limit).toString();

      const variables = {
        id: encodedId,
        pdpReviewsRequest: {
          fieldSelector: "for_p3_translation_only",
          forPreview: false,
          limit,
          offset,
          showingTranslationButton: false,
          first: limit,
          sortingPreference: "BEST_QUALITY",
          checkinDate: checkin,
          checkoutDate: checkout,
          numberOfAdults: adults.toString(),
          numberOfChildren: children.toString(),
          numberOfInfants: infants.toString(),
          numberOfPets: pets.toString(),
        },
        useContextualUser: false,
      };

      const queryParams = new URLSearchParams({
        operationName: "StaysPdpReviewsQuery",
        locale: "en",
        currency: "USD",
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: {
            version: 1,
            sha256Hash:
              "cc333abde7dc5d02628cfbde5dd3ba3b7a4f64c289dd6eccb39eb2b8f735b5fc",
          },
        }),
      });

      const url = `${baseGraphQLUrl}?${queryParams.toString()}`;

      log("info", "url", url);

      const headers = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
      };

      if (apiKey) {
        (headers as Record<string, string>)["x-airbnb-api-key"] = apiKey;
      }

      // Log curl equivalent for debugging
      const curlCommand = `curl -X GET "${url}" ${Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(' ')}`;
      log('info', 'Curl equivalent', { curl: curlCommand });

      const response = await fetch(url, { headers });

      log("info", "response", response);
      const responseBody = await response.text();
      log("info", "response body", responseBody);

      if (!response.ok) {
        throw new Error(`Airbnb API error: ${response.status} ${response.statusText}`);
      }
      const json = JSON.parse(responseBody) as { data?: { presentation?: { stayProductDetailPage?: { reviews?: { reviews?: any[] } } } } };
      const reviews =
        json?.data?.presentation?.stayProductDetailPage?.reviews?.reviews?.map((r: any) => ({
          id: r.id,
          author: r.reviewer?.firstName || null,
          date: r.localizedDate || null,
          rating: r.rating || null,
          comments: r.comments || null,
        })) || [];

      if (reviews.length === 0) break; // stop if no more results
      allReviews.push(...reviews);
    }

    log("info", "Reviews fetched successfully", {
      id,
      totalReviews: allReviews.length,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              listingId: id,
              totalReviews: allReviews.length,
              reviews: allReviews,
            },
            null,
            2
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    log("error", "Reviews request failed", {
      error: error instanceof Error ? error.message : String(error),
      id,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: error instanceof Error ? error.message : String(error),
              listingId: id,
              timestamp: new Date().toISOString(),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
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

      case "airbnb_listing_reviews": {
        result = await handleAirbnbListingReviews(request.params.arguments)
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

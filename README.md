[![downloads](https://img.shields.io/npm/dm/@openbnb/mcp-server-airbnb)](https://www.npmjs.com/package/@openbnb/mcp-server-airbnb)

# Airbnb Search & Listings - MCP Bundle (MCPB)

A comprehensive MCP Bundle for searching Airbnb listings with advanced filtering capabilities and detailed property information retrieval. Built as a Model Context Protocol (MCP) server packaged in the MCP Bundle (MCPB) format for easy installation and use with compatible AI applications.

## Features

### 🔍 Advanced Search Capabilities
- **Location-based search** with support for cities, states, and regions
- **International location support** via client-side geocoding, so non-US queries (e.g. "Paris, France", "Copenhagen, Denmark") return results in the right city
- **Google Maps Place ID** integration for precise location targeting
- **Property type filtering** for entire homes, private rooms, shared rooms, or hotel rooms
- **Date filtering** with check-in and check-out date support
- **Guest configuration** including adults, children, infants, and pets
- **Price range filtering** with minimum and maximum price constraints
- **Pagination support** for browsing through large result sets

### 🏠 Detailed Property Information
- **Comprehensive listing details** including amenities, policies, and highlights
- **Location information** with coordinates and neighborhood details
- **House rules and policies** for informed booking decisions
- **Property descriptions** and key features
- **Direct links** to Airbnb listings for easy booking

### 🛡️ Security & Compliance
- **Robots.txt compliance** with configurable override for testing
- **Request timeout management** to prevent hanging requests
- **Enhanced error handling** with detailed logging
- **Rate limiting awareness** and respectful API usage
- **Secure configuration** through MCPB user settings

## Installation

### For Claude Desktop
This extension is packaged as an MCP Bundle (`.mcpb`) file. To install:

1. Download the `.mcpb` file from the [latest release](https://github.com/openbnb-org/mcp-server-airbnb/releases/latest)
2. Open the file — Claude Desktop will show an installation dialog
3. Configure the extension settings as needed

### For Cursor, etc.

Before starting make sure [Node.js](https://nodejs.org/) is installed on your desktop for `npx` to work.
1. Go to: Cursor Settings > Tools & Integrations > New MCP Server

2. Add one the following to your `mcp.json`:
    ```json
    {
      "mcpServers": {
        "airbnb": {
          "command": "npx",
          "args": [
            "-y",
            "@openbnb/mcp-server-airbnb"
          ]
        }
      }
    }
    ```

    To ignore robots.txt for all requests, use this version with `--ignore-robots-txt` args

    ```json
    {
      "mcpServers": {
        "airbnb": {
          "command": "npx",
          "args": [
            "-y",
            "@openbnb/mcp-server-airbnb",
            "--ignore-robots-txt"
          ]
        }
      }
    }
    ```
3. Restart.


## Configuration

The extension provides the following user-configurable options:

### Ignore robots.txt
- **Type**: Boolean (checkbox)
- **Default**: `false`
- **Description**: Bypass robots.txt restrictions when making requests to Airbnb
- **Recommendation**: Keep disabled unless needed for testing purposes

### Disable third-party geocoding
- **Type**: Boolean (checkbox)
- **Environment variable**: `DISABLE_GEOCODING`
- **Default**: `false`
- **Description**: Skip the Photon/Nominatim geocoding step and let Airbnb resolve the location string on its own. Enabling this restores the pre-PR behavior — every search goes only to `airbnb.com`, no third-party calls.
- **Recommendation**: Keep disabled unless you specifically need zero third-party outbound traffic. With it enabled, non-US searches could return incorrect results. See [External Services](#external-services).

## Tools

### `airbnb_search`

Search for Airbnb listings with comprehensive filtering options.

**Parameters:**
- `location` (required): Location to search (e.g., "San Francisco, CA"). When supplied without `placeId`, the server geocodes this string client-side via Photon/Nominatim — see [External Services](#external-services).
- `placeId` (optional): Google Maps Place ID. Overrides `location` and skips client-side geocoding entirely (no third-party calls).
- `checkin` (optional): Check-in date in YYYY-MM-DD format
- `checkout` (optional): Check-out date in YYYY-MM-DD format
- `adults` (optional): Number of adults (default: 1)
- `children` (optional): Number of children (default: 0)
- `infants` (optional): Number of infants (default: 0)
- `pets` (optional): Number of pets (default: 0)
- `minPrice` (optional): Minimum price per night
- `maxPrice` (optional): Maximum price per night
- `cursor` (optional): Pagination cursor for browsing results
- `propertyType` (optional): Filter by property type — `entire_home`, `private_room`, `shared_room`, or `hotel_room`
- `ignoreRobotsText` (optional): Override robots.txt for this request

**Returns:**
- Search results with property details, pricing, and direct links
- Pagination information for browsing additional results
- Search URL for reference

### `airbnb_listing_details`

Get detailed information about a specific Airbnb listing.

**Parameters:**
- `id` (required): Airbnb listing ID
- `checkin` (optional): Check-in date in YYYY-MM-DD format
- `checkout` (optional): Check-out date in YYYY-MM-DD format
- `adults` (optional): Number of adults (default: 1)
- `children` (optional): Number of children (default: 0)
- `infants` (optional): Number of infants (default: 0)
- `pets` (optional): Number of pets (default: 0)
- `ignoreRobotsText` (optional): Override robots.txt for this request

**Returns:**
- Detailed property information including:
  - Location details with coordinates
  - Amenities and facilities
  - House rules and policies
  - Property highlights and descriptions
  - Direct link to the listing

## Technical Details

### Architecture
- **Runtime**: Node.js 18+
- **Protocol**: Model Context Protocol (MCP) via stdio transport
- **Format**: MCP Bundle (MCPB) v0.3
- **Dependencies**: Minimal external dependencies for security and reliability

### External Services

In addition to `airbnb.com`, the server makes geocoding requests to two third-party services to translate location queries into accurate map bounding boxes. This bypasses Airbnb's own server-side geocoder, which produces incorrect results for many non-US queries (e.g. "Paris, France" lands in Vendée; "Copenhagen, Denmark" lands in Wisconsin).

| Service | Endpoint | Used for | Notes |
| --- | --- | --- | --- |
| [Photon](https://photon.komoot.io/) | `photon.komoot.io` | Primary geocoder, called on every search without `placeId` | Free OSM-based service hosted by Komoot. One request per search. |
| [Nominatim](https://nominatim.openstreetmap.org/) | `nominatim.openstreetmap.org` | Fallback geocoder, called only when Photon does not return a bounding box | Subject to the [OSMF usage policy](https://operations.osmfoundation.org/policies/nominatim/) (max ~1 req/sec). |

Each search sends only the `location` string from the request to the geocoder — no other request fields, no IP geolocation, no tracking identifiers. The location string itself is, of course, the same string the user typed.

**Opting out:** there are two ways to skip the geocoders:

- **Per-request:** supply an explicit `placeId`. When `placeId` is present, the server uses Airbnb's own place lookup directly with no third-party calls.
- **Globally:** set the environment variable `DISABLE_GEOCODING=true`. The server will skip Photon/Nominatim entirely and pass the raw location string to Airbnb. This restores the pre-PR behavior for every search and guarantees zero third-party outbound traffic — at the cost of broken results for non-US locations that Airbnb's own geocoder mishandles. Defaults to `false`.

If a geocoder is unreachable or returns no result, the server falls back to sending the location string to Airbnb directly, exactly as it did before — so the worst case for an outage is that international searches degrade to the previous (broken) behavior, not that the search fails entirely.

### Error Handling
- Comprehensive error logging with timestamps
- Graceful degradation when Airbnb's page structure changes
- Timeout protection for network requests
- Detailed error messages for troubleshooting

### Security Measures
- Robots.txt compliance by default
- Request timeout limits
- Input validation and sanitization
- Secure environment variable handling
- No sensitive data storage

### Performance
- Efficient HTML parsing with Cheerio
- Request caching where appropriate
- Minimal memory footprint
- Fast startup and response times

## Compatibility

- **Platforms**: macOS, Windows, Linux
- **Node.js**: 18.0.0 or higher
- **Claude Desktop**: 0.10.0 or higher
- **Other MCP clients**: Compatible with any MCP-supporting application

## Development

### Building from Source

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Watch for changes during development
npm run watch
```

### Testing

The extension can be tested by running the MCP server directly:

```bash
# Run with robots.txt compliance (default)
node dist/index.js

# Run with robots.txt ignored (for testing)
node dist/index.js --ignore-robots-txt
```

## Legal and Ethical Considerations

- **Respect Airbnb's Terms of Service**: This extension is for legitimate research and booking assistance
- **Robots.txt Compliance**: The extension respects robots.txt by default
- **Rate Limiting**: Be mindful of request frequency to avoid overwhelming Airbnb's servers
- **Data Usage**: Only extract publicly available information for legitimate purposes

## Support

- **Issues**: Report bugs and feature requests on [GitHub Issues](https://github.com/openbnb-org/mcp-server-airbnb/issues)
- **Documentation**: Additional documentation available in the repository
- **Community**: Join discussions about MCP and MCPB development

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please read the contributing guidelines and submit pull requests for any improvements.

---

**Note**: This extension is not affiliated with Airbnb, Inc. It is an independent tool designed to help users search and analyze publicly available Airbnb listings.

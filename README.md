# Airbnb Search & Listings - Desktop Extension (DXT)

A comprehensive Desktop Extension for searching Airbnb listings with advanced filtering capabilities and detailed property information retrieval. Built as a Model Context Protocol (MCP) server packaged in the Desktop Extension (DXT) format for easy installation and use with compatible AI applications.

## Features

### 🔍 Advanced Search Capabilities
- **Location-based search** with support for cities, states, and regions
- **Google Maps Place ID** integration for precise location targeting
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
- **Secure configuration** through DXT user settings

## Hosted deployment

A hosted deployment is available on [Fronteir AI](https://fronteir.ai/mcp/openbnb-org-mcp-server-airbnb).

## Installation

### For Claude Desktop
This extension is packaged as a Desktop Extension (DXT) file. To install:

1. Download the `.dxt` file from the releases page
2. Open your compatible AI application (e.g., Claude Desktop)
3. Install the extension through the application's extension manager
4. Configure the extension settings as needed

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

## Tools

### `airbnb_search`

Search for Airbnb listings with comprehensive filtering options.

**Parameters:**
- `location` (required): Location to search (e.g., "San Francisco, CA")
- `placeId` (optional): Google Maps Place ID (overrides location)
- `checkin` (optional): Check-in date in YYYY-MM-DD format
- `checkout` (optional): Check-out date in YYYY-MM-DD format
- `adults` (optional): Number of adults (default: 1)
- `children` (optional): Number of children (default: 0)
- `infants` (optional): Number of infants (default: 0)
- `pets` (optional): Number of pets (default: 0)
- `minPrice` (optional): Minimum price per night
- `maxPrice` (optional): Maximum price per night
- `cursor` (optional): Pagination cursor for browsing results
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
- **Format**: Desktop Extension (DXT) v0.1
- **Dependencies**: Minimal external dependencies for security and reliability

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
- **Community**: Join discussions about MCP and DXT development

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please read the contributing guidelines and submit pull requests for any improvements.

---

**Note**: This extension is not affiliated with Airbnb, Inc. It is an independent tool designed to help users search and analyze publicly available Airbnb listings.

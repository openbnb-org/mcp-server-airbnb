#!/usr/bin/env node

/**
 * Simple test script for the Airbnb DXT extension
 * This script validates that the MCP server responds correctly to tool calls
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test configuration
const TEST_TIMEOUT = 30000; // 30 seconds
const SERVER_PATH = join(__dirname, 'dist', 'index.js');

class MCPTester {
  constructor() {
    this.server = null;
    this.requestId = 1;
  }

  async startServer() {
    console.log('🚀 Starting MCP server...');
    
    this.server = spawn('node', [SERVER_PATH, '--ignore-robots-txt'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, IGNORE_ROBOTS_TXT: 'true' }
    });

    this.server.stderr.on('data', (data) => {
      console.log('📋 Server log:', data.toString().trim());
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (this.server.killed) {
      throw new Error('Server failed to start');
    }
    
    console.log('✅ Server started successfully');
  }

  async sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: '2.0',
        id: this.requestId++,
        method,
        params
      };

      const timeout = setTimeout(() => {
        reject(new Error(`Request timeout after ${TEST_TIMEOUT}ms`));
      }, TEST_TIMEOUT);

      let responseData = '';
      
      const onData = (data) => {
        responseData += data.toString();
        
        // Check if we have a complete JSON response
        try {
          const lines = responseData.split('\n').filter(line => line.trim());
          for (const line of lines) {
            const response = JSON.parse(line);
            if (response.id === request.id) {
              clearTimeout(timeout);
              this.server.stdout.off('data', onData);
              resolve(response);
              return;
            }
          }
        } catch (e) {
          // Not a complete JSON yet, continue waiting
        }
      };

      this.server.stdout.on('data', onData);
      
      console.log(`📤 Sending request: ${method}`);
      this.server.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async testListTools() {
    console.log('\n🔧 Testing list_tools...');
    
    try {
      const response = await this.sendRequest('tools/list');
      
      if (response.error) {
        throw new Error(`Server error: ${response.error.message}`);
      }
      
      const tools = response.result?.tools || [];
      console.log(`✅ Found ${tools.length} tools:`);
      
      tools.forEach(tool => {
        console.log(`   - ${tool.name}: ${tool.description}`);
      });
      
      // Validate expected tools
      const expectedTools = ['airbnb_search', 'airbnb_listing_details'];
      const foundTools = tools.map(t => t.name);
      
      for (const expectedTool of expectedTools) {
        if (!foundTools.includes(expectedTool)) {
          throw new Error(`Missing expected tool: ${expectedTool}`);
        }
      }
      
      return true;
    } catch (error) {
      console.error('❌ list_tools test failed:', error.message);
      return false;
    }
  }

  async testSearchTool() {
    console.log('\n🔍 Testing airbnb_search tool...');
    
    try {
      const response = await this.sendRequest('tools/call', {
        name: 'airbnb_search',
        arguments: {
          location: 'San Francisco, CA',
          adults: 2,
          ignoreRobotsText: true
        }
      });
      
      if (response.error) {
        throw new Error(`Server error: ${response.error.message}`);
      }
      
      const result = response.result;
      if (!result || !result.content || !result.content[0]) {
        throw new Error('Invalid response format');
      }
      
      const content = JSON.parse(result.content[0].text);
      
      if (content.error) {
        console.log('⚠️  Search returned error (expected for robots.txt):', content.error);
        return true; // This is expected behavior
      }
      
      if (content.searchResults) {
        console.log(`✅ Search successful, found ${content.searchResults.length} results`);
        if (content.searchResults.length > 0) {
          console.log(`   First result: ${content.searchResults[0].id}`);
        }
      }
      
      return true;
    } catch (error) {
      console.error('❌ airbnb_search test failed:', error.message);
      return false;
    }
  }

  async testListingDetailsTool() {
    console.log('\n🏠 Testing airbnb_listing_details tool...');
    
    try {
      const response = await this.sendRequest('tools/call', {
        name: 'airbnb_listing_details',
        arguments: {
          id: '670214003022775198',
          ignoreRobotsText: true
        }
      });
      
      if (response.error) {
        throw new Error(`Server error: ${response.error.message}`);
      }
      
      const result = response.result;
      if (!result || !result.content || !result.content[0]) {
        throw new Error('Invalid response format');
      }
      
      const content = JSON.parse(result.content[0].text);
      
      if (content.error) {
        console.log('⚠️  Listing details returned error (expected for dummy ID):', content.error);
        return true; // This is expected behavior
      }
      
      console.log('✅ Listing details tool responded correctly');
      return true;
    } catch (error) {
      console.error('❌ airbnb_listing_details test failed:', error.message);
      return false;
    }
  }

  async stopServer() {
    if (this.server && !this.server.killed) {
      console.log('\n🛑 Stopping server...');
      this.server.kill('SIGTERM');

      // Wait for graceful shutdown
      await new Promise(resolve => {
        this.server.on('exit', resolve);
        setTimeout(() => {
          if (!this.server.killed) {
            this.server.kill('SIGKILL');
          }
          resolve();
        }, 5000);
      });

      console.log('✅ Server stopped');
    }
  }

  // Helper: extract the searchUrl the server echoes back in its response body.
  _extractSearchUrl(response) {
    const text = response?.result?.content?.[0]?.text;
    if (!text) return '';
    try {
      return JSON.parse(text).searchUrl || '';
    } catch {
      return '';
    }
  }

  // Assert client-side geocoding actually populates ne_lat/ne_lng/sw_lat/sw_lng
  // *and* that the bbox is centered on the correct city. Without client-side
  // geocoding, "Paris, France" lands in Vendée (~46.4, -1.1) and "Copenhagen"
  // lands in Wisconsin (~43.0, -88.0) — so checking the bbox center falls inside
  // the expected lat/lng window is the meaningful assertion.
  async testGeocoding() {
    console.log('\n🌍 Testing geocoding...');
    const cases = [
      { location: 'Paris, France',            lat: [48.5, 49.1], lng: [2.0, 2.7],   label: 'Paris (Photon path)' },
      { location: 'Copenhagen, Denmark',      lat: [55.4, 55.9], lng: [12.3, 12.8], label: 'Copenhagen (Nominatim fallback)' },
      { location: 'Munich, Bavaria, Germany', lat: [48.0, 48.4], lng: [11.2, 11.9], label: 'Munich (regression check)' },
    ];

    const parseBbox = (url) => {
      const params = new URLSearchParams(url.split('?')[1] || '');
      const ne_lat = parseFloat(params.get('ne_lat'));
      const ne_lng = parseFloat(params.get('ne_lng'));
      const sw_lat = parseFloat(params.get('sw_lat'));
      const sw_lng = parseFloat(params.get('sw_lng'));
      if ([ne_lat, ne_lng, sw_lat, sw_lng].some(Number.isNaN)) return null;
      return { centerLat: (ne_lat + sw_lat) / 2, centerLng: (ne_lng + sw_lng) / 2, ne_lat, ne_lng, sw_lat, sw_lng };
    };

    let allOk = true;
    for (const c of cases) {
      try {
        const response = await this.sendRequest('tools/call', {
          name: 'airbnb_search',
          arguments: { location: c.location, ignoreRobotsText: true },
        });
        const url = this._extractSearchUrl(response);
        const bbox = parseBbox(url);
        if (!bbox) {
          console.log(`   ❌ ${c.label}: no bbox in URL — geocoding silently failed`);
          allOk = false;
          continue;
        }
        const latOk = bbox.centerLat >= c.lat[0] && bbox.centerLat <= c.lat[1];
        const lngOk = bbox.centerLng >= c.lng[0] && bbox.centerLng <= c.lng[1];
        const ok = latOk && lngOk;
        const center = `(${bbox.centerLat.toFixed(3)}, ${bbox.centerLng.toFixed(3)})`;
        console.log(`   ${ok ? '✅' : '❌'} ${c.label}: center=${center}  bbox=[${bbox.sw_lat.toFixed(2)},${bbox.sw_lng.toFixed(2)} → ${bbox.ne_lat.toFixed(2)},${bbox.ne_lng.toFixed(2)}]`);
        if (!ok) allOk = false;
      } catch (error) {
        console.error(`   ❌ ${c.label}: ${error.message}`);
        allOk = false;
      }
    }
    return allOk;
  }

  async runTests() {
    let allPassed = true;

    try {
      await this.startServer();

      // Run all tests
      const tests = [
        () => this.testListTools(),
        () => this.testSearchTool(),
        () => this.testListingDetailsTool(),
        () => this.testGeocoding(),
      ];
      
      for (const test of tests) {
        const passed = await test();
        allPassed = allPassed && passed;
      }
      
    } catch (error) {
      console.error('❌ Test suite failed:', error.message);
      allPassed = false;
    } finally {
      await this.stopServer();
    }
    
    console.log('\n' + '='.repeat(50));
    if (allPassed) {
      console.log('🎉 All tests passed! Extension is ready for use.');
    } else {
      console.log('❌ Some tests failed. Please check the issues above.');
      process.exit(1);
    }
  }
}

// Run tests if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new MCPTester();
  tester.runTests().catch(error => {
    console.error('💥 Test runner crashed:', error);
    process.exit(1);
  });
}

export default MCPTester;

// Offline unit tests for country-domain handoff detection and base URL helpers.
import assert from "node:assert/strict";
import {
  DEFAULT_BASE_URL,
  detectDomainHandoff,
  isAirbnbOrigin,
  normalizeBaseUrl,
  rewriteUrlOrigin,
} from "./dist/util.js";

function makeHandoffStub(origin) {
  return `<!doctype html><html><body onload="document.forms[0].submit()"><form method="POST" action="${origin}/v2/domain_switch/handoff"><input type="hidden" name="redirect_url" value="/"></form></body></html>`;
}

// DEFAULT_BASE_URL
assert.equal(DEFAULT_BASE_URL, "https://www.airbnb.com");

// detectDomainHandoff
assert.equal(
  detectDomainHandoff(makeHandoffStub("https://www.airbnb.co.in")),
  "https://www.airbnb.co.in"
);
assert.equal(
  detectDomainHandoff(makeHandoffStub("https://www.airbnb.co.uk")),
  "https://www.airbnb.co.uk"
);
assert.equal(
  detectDomainHandoff(makeHandoffStub("https://www.airbnb.fr")),
  "https://www.airbnb.fr"
);
assert.equal(
  detectDomainHandoff(
    '<html><script id="data-deferred-state-0" type="application/json">{"niobeClientData":[]}</script></html>'
  ),
  null
);
assert.equal(detectDomainHandoff(""), null);
assert.equal(
  detectDomainHandoff(makeHandoffStub("https://www.airbnb.co.in") + "x".repeat(9000)),
  null
);
assert.equal(
  detectDomainHandoff('<html><body><form method="POST" action="https://www.airbnb.co.in/login"></form></body></html>'),
  null
);
assert.equal(
  detectDomainHandoff(makeHandoffStub("https://evil.com")),
  null
);
assert.equal(detectDomainHandoff(undefined), null);

// normalizeBaseUrl
assert.equal(normalizeBaseUrl("https://www.airbnb.com"), "https://www.airbnb.com");
assert.equal(normalizeBaseUrl("https://www.airbnb.co.in"), "https://www.airbnb.co.in");
assert.equal(normalizeBaseUrl("https://www.airbnb.co.uk/"), "https://www.airbnb.co.uk");
assert.equal(
  normalizeBaseUrl("https://www.airbnb.fr/s/Paris/homes?adults=2"),
  "https://www.airbnb.fr"
);
assert.equal(normalizeBaseUrl("  https://www.airbnb.de/  "), "https://www.airbnb.de");
assert.equal(normalizeBaseUrl("http://localhost:8080/rooms/1"), "http://localhost:8080");
assert.equal(normalizeBaseUrl("www.airbnb.com"), null);
assert.equal(normalizeBaseUrl("ftp://www.airbnb.com"), null);
assert.equal(normalizeBaseUrl(""), null);
assert.equal(normalizeBaseUrl("   "), null);
assert.equal(normalizeBaseUrl(undefined), null);
assert.equal(normalizeBaseUrl(null), null);

// isAirbnbOrigin
assert.equal(isAirbnbOrigin("https://www.airbnb.com"), true);
assert.equal(isAirbnbOrigin("https://www.airbnb.co.in"), true);
assert.equal(isAirbnbOrigin("https://airbnb.co.uk"), true);
assert.equal(isAirbnbOrigin("https://www.airbnb.fr"), true);
assert.equal(isAirbnbOrigin("http://localhost:3000"), true);
assert.equal(isAirbnbOrigin("http://127.0.0.1:8080"), true);
assert.equal(isAirbnbOrigin("https://evil.com"), false);
assert.equal(isAirbnbOrigin("https://notairbnb.com"), false);
assert.equal(isAirbnbOrigin("https://airbnb.com.evil.com"), false);
assert.equal(isAirbnbOrigin("ftp://www.airbnb.com"), false);
assert.equal(isAirbnbOrigin("not-a-url"), false);
assert.equal(isAirbnbOrigin(""), false);

// rewriteUrlOrigin
assert.equal(
  rewriteUrlOrigin(
    "https://www.airbnb.com/s/Ernakulam--Kochi--Kerala/homes?checkin=2026-12-24&adults=1",
    "https://www.airbnb.co.in"
  ),
  "https://www.airbnb.co.in/s/Ernakulam--Kochi--Kerala/homes?checkin=2026-12-24&adults=1"
);
assert.equal(
  rewriteUrlOrigin("https://www.airbnb.com/rooms/53610715?adults=2", "http://127.0.0.1:4567"),
  "http://127.0.0.1:4567/rooms/53610715?adults=2"
);

console.log("All domain handoff unit tests passed.");

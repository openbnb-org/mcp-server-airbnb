// Unit: country-domain handoff detection and AIRBNB_BASE_URL normalization.
// Offline by design — no network, so it stays reliable as a regression guard.
import { detectDomainHandoff, normalizeBaseUrl } from "./dist/util.js";

// Captured verbatim from https://www.airbnb.com/s/Lisbon--Portugal/homes from a UK
// IP (HTTP 200, 964 bytes). The payload value is truncated; nothing reads it.
const HANDOFF_STUB = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Redirecting to www.airbnb.co.uk</title></head>
<body onload="document.forms[0].submit()">
<form method="POST" action="https://www.airbnb.co.uk/v2/domain_switch/handoff">
<input type="hidden" name="version" value="1">
<input type="hidden" name="payload" value="eyJjb29raWVzIjp7ImJldiI6IjE3ODYzOTM2NDdf">
<noscript><button type="submit">Redirecting to www.airbnb.co.uk</button></noscript>
</form>
</body>
</html>`;

const CASES = [
  {
    name: "captured .co.uk handoff stub",
    html: HANDOFF_STUB,
    expect: "https://www.airbnb.co.uk",
  },
  {
    name: "handoff to a different country domain",
    html: HANDOFF_STUB.replace(/airbnb\.co\.uk/g, "airbnb.fr"),
    expect: "https://www.airbnb.fr",
  },
  {
    name: "real page is not a handoff",
    html: `<!DOCTYPE html><html><body><script id="data-deferred-state-0">{"niobeClientData":[]}</script></body></html>`,
    expect: null,
  },
  {
    name: "empty response",
    html: "",
    expect: null,
  },
  {
    // Guards the size bail-out: a full page mentioning the path must not be
    // mistaken for a stub, or a working search would start failing.
    name: "large page mentioning the handoff path",
    html: `<form action="https://www.airbnb.co.uk/v2/domain_switch/handoff">` + "x".repeat(9000),
    expect: null,
  },
  {
    name: "form without the handoff action",
    html: `<form method="POST" action="https://www.airbnb.co.uk/v2/login"></form>`,
    expect: null,
  },
  {
    name: "non-string input",
    html: undefined,
    expect: null,
  },
];

const BASE_URL_CASES = [
  { name: "country domain", input: "https://www.airbnb.co.uk", expect: "https://www.airbnb.co.uk" },
  { name: "trailing slash is stripped", input: "https://www.airbnb.co.uk/", expect: "https://www.airbnb.co.uk" },
  { name: "stray path is dropped", input: "https://www.airbnb.co.uk/homes", expect: "https://www.airbnb.co.uk" },
  { name: "surrounding whitespace", input: "  https://www.airbnb.fr  ", expect: "https://www.airbnb.fr" },
  { name: "explicit port is kept", input: "http://localhost:8080", expect: "http://localhost:8080" },
  { name: "missing scheme is rejected", input: "www.airbnb.co.uk", expect: null },
  { name: "non-http scheme is rejected", input: "ftp://www.airbnb.co.uk", expect: null },
  { name: "empty string falls through to default", input: "", expect: null },
  { name: "whitespace only falls through to default", input: "   ", expect: null },
  { name: "undefined falls through to default", input: undefined, expect: null },
];

let failures = 0;

console.log("detectDomainHandoff:");
for (const c of CASES) {
  const got = detectDomainHandoff(c.html);
  if (got !== c.expect) {
    console.log(`  FAIL: ${c.name} — expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`);
    failures++;
  } else {
    console.log(`  ok: ${c.name}`);
  }
}

console.log("\nnormalizeBaseUrl:");
for (const c of BASE_URL_CASES) {
  const got = normalizeBaseUrl(c.input);
  if (got !== c.expect) {
    console.log(`  FAIL: ${c.name} — expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`);
    failures++;
  } else {
    console.log(`  ok: ${c.name}`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall cases passed");
process.exit(failures ? 1 : 0);

#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "contracts", "portal-api-v1.json");
const checksumPath = path.join(root, "contracts", "portal-api-v1.sha256");
const peerRoot = process.env.PORTAL_CONTRACT_PEER_ROOT;

if (!peerRoot || peerRoot.trim() === "") {
  console.error(
    "ERROR: PORTAL_CONTRACT_PEER_ROOT is required for cross-repo contract verification.\n" +
    "Set it to the absolute path of the peer repository root that contains contracts/portal-api-v1.json\n" +
    "Example: PORTAL_CONTRACT_PEER_ROOT=/path/to/peer-repo npm run verify:contract",
  );
  process.exit(1);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function assertArray(value, name, minLength = 1) {
  if (!Array.isArray(value) || value.length < minLength) fail(`invalid array: ${name}`);
}

function assertExactSet(actual, expected, name) {
  assertArray(actual, name);
  if (actual.length !== expected.length || !expected.every((item) => actual.includes(item))) {
    fail(`invalid allowlist: ${name}`);
  }
}

function assertContainsAll(actual, expected, name) {
  assertArray(actual, name);
  for (const item of expected) {
    if (!actual.includes(item)) fail(`missing required value in ${name}: ${item}`);
  }
}

function assertNoSecretValues(node, keyPath = "") {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoSecretValues(item, `${keyPath}[${index}]`));
    return;
  }
  if (!node || typeof node !== "object") {
    if (keyPath.endsWith("committedValue") && node !== null) {
      fail(`fixture exposes a committed value at ${keyPath}`);
    }
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const childPath = keyPath ? `${keyPath}.${key}` : key;
    const explicitEmptySecretList = key === "committedSecretValues" && Array.isArray(value) && value.length === 0;
    if (/secretvalue|credential|password/i.test(key) && !explicitEmptySecretList && value !== false) {
      fail(`fixture exposes sensitive data at ${childPath}`);
    }
    assertNoSecretValues(value, childPath);
  }
}

const resolvedPeerRoot = path.resolve(peerRoot.trim());
let peerFixtureBytes;
let peerDigestRaw;
try {
  [peerFixtureBytes, peerDigestRaw] = await Promise.all([
    readFile(path.join(resolvedPeerRoot, "contracts", "portal-api-v1.json")),
    readFile(path.join(resolvedPeerRoot, "contracts", "portal-api-v1.sha256"), "utf8"),
  ]);
} catch {
  fail(
    `cannot read peer contract files under PORTAL_CONTRACT_PEER_ROOT=${resolvedPeerRoot}\n` +
    `Expected: ${path.join(resolvedPeerRoot, "contracts", "portal-api-v1.json")} and .sha256`,
  );
}

const [fixtureBytes, committedDigest] = await Promise.all([
  readFile(fixturePath),
  readFile(checksumPath, "utf8"),
]);

const actualDigest = createHash("sha256").update(fixtureBytes).digest("hex");
const expectedDigest = committedDigest.trim().split(/\s+/)[0];
const peerExpectedDigest = peerDigestRaw.trim().split(/\s+/)[0];

if (!/^[0-9a-f]{64}$/.test(expectedDigest) || expectedDigest !== actualDigest) {
  fail("fixture SHA-256 sidecar does not match");
}
if (!peerFixtureBytes.equals(fixtureBytes) || peerExpectedDigest !== expectedDigest) {
  fail("shared portal-api-v1 fixture bytes or digest differ between repositories");
}

let contract;
try {
  contract = JSON.parse(fixtureBytes.toString("utf8"));
} catch (error) {
  fail(`fixture is not valid JSON: ${error.message}`);
}

if (contract.contract !== "portal-api-v1" || contract.version !== 1) fail("invalid contract identity");
assertArray(contract.routeInventory?.routes, "routeInventory.routes", 11);
assertContainsAll(
  contract.routeInventory.routes.map((route) => `${route.method} ${route.path}`),
  [
    "POST /auth/register",
    "POST /auth/verify",
    "POST /auth/resend",
    "POST /auth/login",
    "POST /auth/logout",
    "GET /me",
    "GET /quotes",
    "GET /quotes/:publicId",
    "POST /quotes/calculate",
    "POST /quotes/:publicId/pdf/generate",
    "GET /quotes/:publicId/pdf",
  ],
  "route inventory",
);
if (contract.headerContract?.service?.name !== "Authorization") fail("missing service header contract");
if (contract.headerContract?.portalSession?.name !== "X-Portal-Session-Token") fail("missing session header contract");
if (contract.headerContract?.clientFingerprint?.name !== "X-Portal-Client-Fingerprint") {
  fail("missing client fingerprint header contract");
}
assertExactSet(
  contract.registration?.request?.allowlist,
  ["companyName", "contactName", "postalCode", "address", "telephone", "email", "password"],
  "registration.allowlist",
);
assertContainsAll(
  contract.quoteCalculation?.request?.topLevelAllowlist,
  ["idempotencyKey", "productName", "sizeKey", "customWidthMm", "customLengthMm", "fillMlPerChamber", "connectedChambers", "fillingMethod", "fillingLanes", "printingMethod", "quantity", "skus", "deliveryDate", "notes"],
  "quote top-level allowlist",
);
assertContainsAll(
  contract.quoteCalculation?.pricingAuthorityDenial?.deniedFields,
  [
    "parameters",
    "parameters.filmUnitPrices",
    "gravureYRows",
    "ySupplierRows",
    "pricingSnapshot",
    "publicProjectionHash",
    "pricingSnapshotSha256",
    "fullAugmentedCalculationRequest",
  ],
  "pricing authority denial fields",
);
assertContainsAll(
  contract.customerSafeQuoteProjection?.allowlist,
  ["publicId", "quotationNumber", "quantity", "displayedGrandTotal", "pdfAvailability", "availability"],
  "customer-safe projection",
);
assertContainsAll(
  contract.forbiddenResponseFields,
  [
    "cost",
    "margin",
    "profit",
    "film",
    "filmOrder",
    "supplier",
    "pricingSnapshot",
    "payload",
    "payloadJson",
    "resultHash",
    "internalQuotationId",
  ],
  "forbidden response fields",
);
assertContainsAll(
  contract.errorCodes,
  ["validation_failed", "pricing_authority_rejected", "unauthorized", "email_unverified", "session_expired", "not_found", "conflict", "rate_limited", "internal_error"],
  "error codes",
);
assertNoSecretValues(contract);

console.log(`portal-api-v1 fixture verified: sha256=${actualDigest}`);

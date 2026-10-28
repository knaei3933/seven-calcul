import { expect, test, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D } from "../../src/lib/decimal";
import { defaultGravureKSource } from "../../src/lib/gravure-price-store";

type Projection = {
  pricingSnapshot: { id: string; sha256: string; asOf: string; resolverVersion: string; view: "redacted" };
  resultHash: string;
  quantity: string;
  selectedCandidateId: string;
  candidates: Array<{
    id: string; route: string; adjustedQuantity: string; orderLengthM: string;
    filmTotalYen: string; filmCostPerPieceYen: string; allInCostPerPieceYen?: string;
  }>;
};

const calculationBody = {
  spec: {
    sizeKey: "tube-35x80",
    customWidthMm: "35",
    customLengthMm: "80",
    fillMlPerChamber: "10",
    connectedChambers: 1,
    fillingMethod: "hopper",
    fillingLanes: 4,
    isCustom: false,
    colorCount: 2,
    bulkUnitPrice: "0",
    skuCount: 2,
    skuQuantities: ["500000", "500000"],
    skuNames: ["Serum", "Emulsion"],
    skuFillMlPerChamber: ["10", "20"],
    skuColorCounts: ["2", "3"],
  },
  quantity: "1000000",
  printingMethod: "gravure",
  parameters: undefined,
  targetMargins: ["0.3"],
  recommendationMode: true,
  selectedCandidateId: "",
  selectedCandidateTargetMargins: ["0.3"],
};

test.describe.configure({ mode: "serial" });

let kanai: APIRequestContext;
let seven: APIRequestContext;
let baseline!: Projection;
let noMasterRedacted!: Projection;
let baselineY!: Projection["candidates"][number];
let yRowId = 0;
let kRowId = 0;

async function postJson(context: APIRequestContext, url: string, body: unknown) {
  return context.post(url, { data: body as object });
}

async function activeYOverrideId(): Promise<number | null> {
  const response = await kanai.get("/api/film-prices/gravure/y");
  expect(response.status()).toBe(200);
  const payload = await response.json() as {
    prices: Array<Pick<import("../../src/lib/gravure-price-store").GravureYMasterRow,
      "id" | "webWidthMm" | "laneCount" | "printTierM" | "effectiveFrom" | "effectiveTo">>;
  };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
  const active = payload.prices.find((price) => price.webWidthMm === 356
    && price.laneCount === 1 && price.printTierM === 2000
    && price.effectiveFrom <= today && today <= price.effectiveTo);
  return active?.id ?? null;
}

async function ensureActiveKSource(
  source: ReturnType<typeof defaultGravureKSource>,
  memo: string,
  effectiveFrom = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" }),
): Promise<number> {
  const response = await kanai.get("/api/film-prices/gravure/k");
  expect(response.status()).toBe(200);
  const payload = await response.json() as {
    parameterSets: Array<{
      id: number;
      source: { petPriceKrwPerKg: string; krwPer100Yen: string };
      effectiveFrom: string;
      effectiveTo: string;
    }>;
  };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
  const active = payload.parameterSets.find((row) => row.source.petPriceKrwPerKg === source.petPriceKrwPerKg
    && row.source.krwPer100Yen === source.krwPer100Yen
    && row.effectiveFrom <= today && today <= row.effectiveTo);
  if (active) return active.id;

  const previous = payload.parameterSets.find((row) => row.effectiveFrom <= today && today <= row.effectiveTo);
  if (previous) {
    const supersede = await postJson(kanai, `/api/film-prices/gravure/k/${previous.id}/supersede`, {
      source,
      memo,
      effectiveFrom,
    });
    expect(supersede.status()).toBe(201);
    const supersedePayload = await supersede.json() as { parameterSet: { id: number } };
    return supersedePayload.parameterSet.id;
  }

  const created = await postJson(kanai, "/api/film-prices/gravure/k", {
    source,
    memo,
    effectiveFrom: effectiveFrom,
  });
  expect(created.status()).toBe(201);
  const createdPayload = await created.json() as { parameterSet: { id: number } };
  return createdPayload.parameterSet.id;
}

function expectRedactedProjection(value: unknown): asserts value is Projection {
  expect(value).toBeInstanceOf(Object);
  expect(Object.keys(value as object).sort()).toEqual([
    "calculationVersion", "candidates", "connectedChambers", "fillingMethod", "pricingSnapshot",
    "printingMethod", "publicProjectionHash", "quantity", "resultHash", "selectedCandidateId", "size",
  ]);
  const projection = value as Projection;
  expect(projection.pricingSnapshot).toBeInstanceOf(Object);
  expect(Object.keys(projection.pricingSnapshot).sort()).toEqual(["asOf", "id", "resolverVersion", "sha256", "view"]);
  expect(projection.pricingSnapshot.view).toBe("redacted");
  expect(projection.candidates.length).toBeGreaterThan(0);
  const candidateKeys = [
    "adjustedQuantity", "adjustedSkuQuantities", "allInCostPerPieceYen", "capacityQuantity", "colorText",
    "compositionText", "detailLabel", "effectiveLengthM", "filmCostPerPieceYen", "filmTotalYen", "id",
    "materialText", "orderLengthM", "patternText", "pouchSpecText", "printingMethod", "requiredLengthM",
    "route",
  ].sort();
  for (const candidate of projection.candidates) {
    expect(Object.keys(candidate).every((key) => candidateKeys.includes(key))).toBe(true);
    expect(Object.keys(candidate)).not.toContain("supplierUnitPriceYenPerM");
    expect(Object.keys(candidate)).not.toContain("sellerMarkup");
    expect(Object.keys(candidate)).not.toContain("plateUnitPriceYen");
    expect(Object.keys(candidate)).not.toContain("sourceRows");
  }
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "supplierUnitPriceYenPerM", "sellerMarkup", "plateBaseYenPerColor", "plateUnitPriceYen",
    "petPriceKrwPerKg", "laminationUnitPriceYenPerMWithAl", "sourceRows", "fullAugmentedCalculationRequest",
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
}

function quoteBody(projection: Projection, quotationNumber: string) {
  const selected = projection.candidates.find((candidate) => candidate.id === projection.selectedCandidateId)
    ?? projection.candidates[0];
  return {
    quotationNumber,
    status: "draft",
    issueDate: "2026-10-11",
    validUntil: "2026-11-11",
    customerName: "E2E Redacted KK",
    customerContact: "",
    productName: "Gravure E2E",
    sizeSummary: "35x80",
    quantity: selected.adjustedQuantity,
    fillingCostPerPiece: "0",
    filmCostPerPiece: selected.filmCostPerPieceYen,
    filmMeterPrice: D(selected.filmTotalYen).div(selected.orderLengthM).toString(),
    filmOrderLengthM: selected.orderLengthM,
    targetMargin: "0.3",
    taxRatePercent: "10",
    pricePerPiece: "100",
    subtotal: selected.adjustedQuantity,
    tax: "0",
    grandTotal: selected.adjustedQuantity,
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "2026-10.2-gravure-master",
    resultHash: projection.resultHash,
    payload: {
      customerEmail: "gravure-e2e@7chemical.co.jp",
      customerPostalCode: "1000001",
      customerTelephone: "0300000000",
      customerAddress: "Tokyo",
      pricingSnapshot: {
        id: projection.pricingSnapshot.id,
        sha256: projection.pricingSnapshot.sha256,
        publicProjection: projection,
      },
    },
  };
}

test.beforeAll(async ({}, testInfo) => {
  kanai = await playwrightRequest.newContext({
    baseURL: "http://127.0.0.1:3101",
    storageState: join(tmpdir(), "pouch-playwright-kanai-state.json"),
  });

  const sevenEmail = `seven-e2e-${testInfo.workerIndex}-${Date.now()}@7chemical.co.jp`;
  const created = await postJson(kanai, "/api/users", {
    email: sevenEmail,
    name: "Seven Chemical E2E",
    password: "seven-e2e-password",
    role: "user",
  });
  expect(created.status()).toBe(201);
  seven = await playwrightRequest.newContext({ baseURL: "http://127.0.0.1:3101" });
  const login = await postJson(seven, "/api/auth/login", { email: sevenEmail, password: "seven-e2e-password" });
  expect(login.status()).toBe(200);

  const yList = await kanai.get("/api/film-prices/gravure/y");
  expect(yList.status()).toBe(200);
  const yPrices = (await yList.json()) as { prices: unknown[] };
  expect(Array.isArray(yPrices.prices)).toBe(true);

  const kList = await kanai.get("/api/film-prices/gravure/k");
  expect(kList.status()).toBe(200);
  const kSets = (await kList.json()) as { parameterSets: unknown[] };
  expect(Array.isArray(kSets.parameterSets)).toBe(true);

  const adminResponse = await postJson(kanai, "/api/calculate", calculationBody);
  expect(adminResponse.status()).toBe(200);
  const adminPayload = await adminResponse.json() as { result?: unknown; pricingSnapshot?: unknown };
  expect(adminPayload.result).toBeInstanceOf(Object);
  expect(adminPayload.pricingSnapshot).toBeInstanceOf(Object);

  const ordinaryResponse = await postJson(seven, "/api/calculate", calculationBody);
  expect(ordinaryResponse.status()).toBe(200);
  const ordinaryPayload = await ordinaryResponse.json() as {
    result: unknown;
    originalResult: unknown;
    candidates: unknown[];
    calculationRequest: unknown;
    pricingSnapshot: unknown;
    returnedProjection: Projection;
  };
  expect(ordinaryPayload.result).toBeInstanceOf(Object);
  expect(ordinaryPayload.originalResult).toBeInstanceOf(Object);
  expect(Array.isArray(ordinaryPayload.candidates)).toBe(true);
  expect(ordinaryPayload.calculationRequest).toBeInstanceOf(Object);
  expect(ordinaryPayload.pricingSnapshot).toBeInstanceOf(Object);
  noMasterRedacted = ordinaryPayload.returnedProjection;
  expectRedactedProjection(noMasterRedacted);
  baseline = structuredClone(noMasterRedacted);
  baselineY = baseline.candidates.find((candidate) => candidate.route === "Y")!;
});

test("no-master baseline exposes authoritative projection and full simulator response", async () => {
  expect(noMasterRedacted.pricingSnapshot.id).not.toBe("");
  expect(noMasterRedacted.resultHash).toBeTruthy();
  const digital = await postJson(kanai, "/api/calculate", { ...calculationBody, printingMethod: "digital", recommendationMode: false });
  expect(digital.status()).toBe(200);
  const payload = await digital.json() as { result?: unknown; originalResult?: unknown; candidates?: unknown[] };
  expect(payload.result).toBeInstanceOf(Object);
  expect(payload.originalResult).toBeInstanceOf(Object);
  expect(Array.isArray(payload.candidates)).toBe(true);
});

test("Y override changes only the Y route and propagates non-1.12 markup", async ({}) => {
  yRowId = await activeYOverrideId() ?? 0;
  if (!yRowId) {
    const response = await postJson(kanai, "/api/film-prices/gravure/y", {
      webWidthMm: 356,
      laneCount: 1,
      printTierM: 2000,
      approxOutputLengthM: "1700",
      supplierUnitPriceYenPerM: "150.00",
      plateBaseYenPerColor: "27000.50",
      sellerMarkup: "1.25",
      memo: "E2E active Y",
      effectiveFrom: "2026-01-01",
    });
    expect(response.status()).toBe(201);
    const payload = await response.json() as { price: { id: number } };
    yRowId = payload.price.id;
  }
  expect(yRowId).toBeGreaterThan(0);

  const response2 = await postJson(kanai, "/api/calculate", calculationBody);
  expect(response2.status()).toBe(200);
  const full = await response2.json() as { result: { recommendationCandidates: Projection["candidates"] } };
  const redacted = await (await postJson(seven, "/api/calculate", calculationBody)).json() as { returnedProjection: Projection };
  expectRedactedProjection(redacted.returnedProjection);

  const singleSkuBody = {
    ...calculationBody,
    quantity: "10000",
    spec: {
      ...calculationBody.spec,
      skuCount: 1,
      skuQuantities: ["10000"],
      skuNames: ["Serum"],
      skuFillMlPerChamber: ["10"],
      skuColorCounts: ["2"],
    },
    selectedCandidateId: "Y-Y-356-1-2000-exact",
  };
  const selectedBody = singleSkuBody;
  const selectedFullResponse = await postJson(kanai, "/api/calculate", selectedBody);
  expect(selectedFullResponse.status()).toBe(200);
  const selectedFull = await selectedFullResponse.json() as { result: { printingMethod: string; orderLengthM: string; film: { orderLengthM: string }; filmTotalYen: string } };
  const selectedRedactedResponse = await postJson(seven, "/api/calculate", selectedBody);
  expect(selectedRedactedResponse.status()).toBe(200);
  const selectedRedacted = await selectedRedactedResponse.json() as { returnedProjection: Projection };
  const selectedProjection = selectedRedacted.returnedProjection;
  expectRedactedProjection(selectedProjection);
  expect(selectedFull.result.printingMethod).toBe("gravure");
  expect(D(selectedFull.result.filmTotalYen).toString()).toBe(
    D(selectedFull.result.orderLengthM).times("150").times("1.25").toString(),
  );
  expect(selectedProjection.selectedCandidateId).toBe("Y-Y-356-1-2000-exact");
  const redactedY = selectedProjection.candidates.find((candidate) => candidate.id === "Y-Y-356-1-2000-exact")!;
  expect(D(redactedY.filmTotalYen).toString()).toBe(
    D(redactedY.orderLengthM).times("150").times("1.25").toString(),
  );
  const fullY = selectedFull.result;
  expect(redactedY.orderLengthM).toBe(fullY.film.orderLengthM);
  const redactedProjection = redacted.returnedProjection;
  for (const candidate of redactedProjection.candidates.filter((item) => item.route !== "Y")) {
    const before = baseline.candidates.find((old) => old.id === candidate.id)!;
    expect(candidate.filmTotalYen).toBe(before.filmTotalYen);
  }
  expect(redactedProjection.pricingSnapshot.id).not.toBe(baseline.pricingSnapshot.id);
});

test("K override changes only the K route", async ({}) => {
  const runSuffix = String(Date.now() % 1000).padStart(3, "0");
  const source = { ...defaultGravureKSource(), petPriceKrwPerKg: "5000", krwPer100Yen: `500.${runSuffix}` };
  kRowId = await ensureActiveKSource(source, "E2E active K");

  const response2 = await postJson(seven, "/api/calculate", calculationBody);
  expect(response2.status()).toBe(200);
  const redacted = await response2.json() as { returnedProjection: Projection };
  const projection = redacted.returnedProjection;
  expectRedactedProjection(projection);

  const kCandidate = projection.candidates.find((candidate) => candidate.route === "K")!;
  const kBefore = baseline.candidates.find((candidate) => candidate.route === "K")!;
  expect(kCandidate.filmTotalYen).not.toBe(kBefore.filmTotalYen);
  const digitalAfter = projection.candidates.filter((item) => item.route === "D");
  const digitalBefore = baseline.candidates.filter((item) => item.route === "D");
  expect(digitalAfter.map((candidate) => [candidate.id, candidate.filmTotalYen])).toEqual(
    digitalBefore.map((candidate) => [candidate.id, candidate.filmTotalYen]),
  );
});

test("ordinary redacted issuance succeeds and master changes do not invalidate the old snapshot", async ({}) => {
  const changed = await postJson(kanai, "/api/calculate", calculationBody);
  const changedProjection = await changed.json() as { returnedProjection: Projection };
  expect(changedProjection.returnedProjection.pricingSnapshot.id).not.toBe(baseline.pricingSnapshot.id);

  const response = await seven.post("/api/quotations", {
    multipart: {
      payload: JSON.stringify(quoteBody(baseline, `G-E2E-OLD-${Date.now()}`)),
      pdf: {
        name: "quotation.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n%canonical-e2e"),
      },
    },
  });
  expect(response.status()).toBe(201);
  const payload = await response.json() as { record?: { customerName?: string; payload?: Record<string, unknown> } };
  expect(payload.record?.customerName).toBe("E2E Redacted KK");
  const serialized = JSON.stringify(payload.record);
  for (const forbidden of ["supplierUnitPriceYenPerM", "sellerMarkup", "plateBaseYenPerColor", "sourceRows"]) {
    expect(serialized).not.toContain(forbidden);
  }
});

test("tampered snapshot id, hash, or merged projection fails issuance", async ({}) => {
  const suffix = Date.now();
  const cases = [
    ["id", (body: ReturnType<typeof quoteBody>) => { body.payload.pricingSnapshot.id = "00000000-0000-4000-8000-000000000000"; }],
    ["hash", (body: ReturnType<typeof quoteBody>) => { body.payload.pricingSnapshot.sha256 = "0".repeat(64); }],
    ["merge", (body: ReturnType<typeof quoteBody>) => { body.payload.pricingSnapshot.publicProjection.candidates[0].filmTotalYen = "1"; }],
  ] as const;
  for (const [name, mutate] of cases) {
    const body = quoteBody(baseline, `G-E2E-BAD-${name}-${suffix}`);
    mutate(body);
    const response = await seven.post("/api/quotations", {
      multipart: {
        payload: JSON.stringify(body),
        pdf: {
          name: "quotation.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF-1.4\n%canonical-e2e"),
        },
      },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: "pricing_snapshot_invalid" });
  }
});

test("success and error responses pass strict redaction", async ({}) => {
  const success = await postJson(seven, "/api/calculate", calculationBody);
  expect(success.status()).toBe(200);
  const successPayload = await success.json() as { returnedProjection: Projection };
  expectRedactedProjection(successPayload.returnedProjection);

  const failure = await postJson(seven, "/api/calculate", { ...calculationBody, quantity: "0" });
  expect(failure.status()).toBe(400);
  const failurePayload = await failure.json() as Record<string, unknown>;
  expect(failurePayload).toEqual({ error: "invalid_positive_input" });
  const serialized = JSON.stringify(failurePayload);
  for (const forbidden of ["supplierUnitPriceYenPerM", "sellerMarkup", "plateBaseYenPerColor", "petPriceKrwPerKg", "sourceRows"]) {
    expect(serialized).not.toContain(forbidden);
  }
});

test.afterAll(async () => {
  if (yRowId) {
    const response = await postJson(kanai, `/api/film-prices/gravure/y/${yRowId}/supersede`, {
      webWidthMm: 356,
      laneCount: 1,
      printTierM: 2000,
      approxOutputLengthM: "1700",
      supplierUnitPriceYenPerM: "150.00",
      plateBaseYenPerColor: "27000.50",
      sellerMarkup: "1.25",
      effectiveFrom: "2099-01-01",
    });
    expect([201, 400, 409]).toContain(response.status());
  }
  if (kRowId) {
    const response = await postJson(kanai, `/api/film-prices/gravure/k/${kRowId}/supersede`, {
      source: { ...defaultGravureKSource(), petPriceKrwPerKg: "5000", krwPer100Yen: "500" },
      effectiveFrom: "2099-01-01",
    });
    expect([201, 400, 409]).toContain(response.status());
  }
  await seven.dispose();
  await kanai.dispose();
});

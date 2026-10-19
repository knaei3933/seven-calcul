// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "gravure-master-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "kanai@kanei-trade.co.jp";
process.env.ADMIN_PASSWORD = "kanai-master-password";
process.env.ADMIN_NAME = "Kanai Admin";
const { calculatePouchCost } = await import("@/lib/calculation");
const { canonicalize } = await import("@/lib/canonical-json");
const { defaultGravureRollParameters, GRAVURE_ROLL_DEFAULTS_KRW } = await import("@/lib/gravure-roll");
const {
  createGravureKMasterRow,
  createGravureYMasterRow,
  defaultGravureKSource,
  deriveGravureKParameters,
  GRAVURE_K_SOURCE_FIELDS,
  GravureValidationError,
  getGravureSnapshot,
  getGravureMigrationVersion,
  isGravureSnapshotIssuanceEnabled,
  listGravureKMasterRows,
  listGravureYMasterRows,
  sha256Canonical,
  supersedeGravureKMasterRow,
  supersedeGravureYMasterRow,
  validateGravureYMasterInput,
  validateGravureKMasterInput,
  verifyGravureSnapshot,
  verifyGravureSnapshotIssuance,
} = await import("@/lib/gravure-price-store");
const { createUser, createSession } = await import("@/lib/auth-store");
const { POST: calculatePost } = await import("@/app/api/calculate/route");
type CalculationInput = import("@/lib/calculation").CalculationInput;

const yInput = {
  webWidthMm: 356,
  laneCount: 1,
  printTierM: 2000,
  approxOutputLengthM: "1700",
  supplierUnitPriceYenPerM: "150.00",
  plateBaseYenPerColor: "27000.50",
  sellerMarkup: "1.250000",
  effectiveFrom: "2026-10-01",
  memo: "override",
};

const gravureRequest: CalculationInput = {
  spec: {
    sizeKey: "tube-35x80",
    customWidthMm: "35",
    customLengthMm: "80",
    fillMlPerChamber: "10",
    connectedChambers: 1 as const,
    fillingMethod: "hopper" as const,
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
  printingMethod: "gravure" as const,
  parameters: undefined,
  gravureParameters: defaultGravureRollParameters(),
  targetMargins: ["0.3"],
  recommendationMode: true,
  selectedCandidateId: "",
  selectedCandidateTargetMargins: ["0.3"],
};

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

function quotationIssuanceRequest(payload: unknown, token: string): Request {
  const formData = new FormData();
  formData.set("payload", JSON.stringify(payload));
  formData.set("pdf", new Blob([new TextEncoder().encode("%PDF-canonical")], { type: "application/pdf" }), "quotation.pdf");
  return new Request("http://localhost/api/quotations", {
    method: "POST",
    body: formData,
    headers: { cookie: `pouch_session=${token}` },
  });
}

describe("gravure master foundation", () => {
  it("sorts canonical keys by Unicode code unit and normalizes decimals recursively", () => {
    const left = { b: "1.2300", a: { d: ".5", c: "10" } };
    const right = { a: { c: "10", d: "0.500" }, b: "1.23" };
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
    expect(canonicalize(right)).toBe('{"a":{"c":"10","d":"0.5"},"b":"1.23"}');
  });

  it("records the additive migration and rollback switch", async () => {
    expect(await getGravureMigrationVersion()).toBe(1);
    const previous = process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED;
    process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = "false";
    expect(isGravureSnapshotIssuanceEnabled()).toBe(false);
    if (previous === undefined) delete process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED;
    else process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = previous;
    expect(isGravureSnapshotIssuanceEnabled()).toBe(true);
  });

  it("rejects rollover calendar dates and unknown K source fields", () => {
    expect(() => validateGravureYMasterInput({ ...yInput, effectiveFrom: "2026-02-30" })).toThrow("invalid_effective_date");
    expect(() => validateGravureKMasterInput({
      source: { ...defaultGravureKSource(), attackerField: "1" } as never,
      effectiveFrom: "2027-01-01",
    })).toThrow("unknown_k_source_field");
  });
  it("hashes the approved canonical public projection vector byte-for-byte", async () => {
    const vector = {
      calculationVersion: "2026-10.2-gravure-master",
      candidates: [{
        adjustedQuantity: "10000",
        filmTotalYen: "100000",
        id: "Y-556-1-2000-10000",
        route: "Y",
      }],
      connectedChambers: 1,
      fillingMethod: "hopper",
      pricingSnapshot: {
        asOf: "2026-10-11",
        id: "0197aaaa-bbbb-7ccc-8ddd-eeeeffff0000",
        resolverVersion: "gravure-pricing-master-v1",
        sha256: "snapshot-hash",
        view: "redacted",
      },
      printingMethod: "gravure",
      quantity: "10000",
      resultHash: "result-hash",
      selectedCandidateId: "Y-556-1-2000-10000",
      size: { lengthMm: "120", widthMm: "60" },
    };
    expect(sha256Canonical(vector)).toBe("bc6c61cb9e98a275be89a1b2fb520938bf9205df640fb1afe433bfbee5e3480e");
  });

  it("falls back exactly to the current Y matrix and retains source composition", () => {
    const result = calculatePouchCost(gravureRequest);
    const candidate = result.recommendationCandidates!.find((item) => item.route === "Y")!;
    expect(candidate.sasche?.sellerMarkup).toBe("1.12");
    expect(Number(candidate.sasche?.filmUnitPriceYen)).toBeCloseTo(Number(candidate.sasche?.sourceRows[0].supplierUnitPriceYenPerM) * 1.12, 8);
    expect(candidate.sasche?.sourceRows.length).toBeGreaterThan(0);
    expect(candidate.sasche?.sourceRows[0].id).toBeLessThan(0);
  });

  it("propagates a validated non-1.12 Y markup through repeated and composite candidates", async () => {
    await createGravureYMasterRow(validateGravureYMasterInput(yInput), "kanai@kanei-trade.co.jp");
    const rows = (await import("@/lib/gravure-price-store")).resolveGravureMasters;
    const resolved = await rows("2026-10-11");
    const result = calculatePouchCost({
      ...gravureRequest,
      gravureYRows: resolved.yRows,
    });
    const repeated = result.recommendationCandidates!.filter((item) => item.route === "Y");
    expect(repeated.length).toBeGreaterThan(0);
    expect(resolved.yRows).toHaveLength(12);
    expect(new Set(resolved.yRows.map((row) => [row.webWidthMm, row.laneCount, row.printTierM].join(":")))).toEqual(
      new Set((await import("@/lib/sasche-gravure")).defaultGravureYSupplierRows().map((row) => [row.webWidthMm, row.laneCount, row.printTierM].join(":"))),
    );
    for (const candidate of repeated) {
      const source = candidate.sasche!.sourceRows[0];
      const isOverridden = source.webWidthMm === 356 && source.laneCount === 1 && source.printTierM === 2000;
      expect(source.sellerMarkup).toBe(isOverridden ? "1.25" : "1.12");
      expect(source.id <= -1 || source.id > 0).toBe(true);
      if (isOverridden) expect(source.id).toBeGreaterThan(0);
      expect(candidate.sasche!.sellerMarkup).toBe(source.sellerMarkup);
      const expectedUnit = Number(source.supplierUnitPriceYenPerM) * Number(source.sellerMarkup);
      expect(Number(candidate.sasche!.filmUnitPriceYen)).toBeCloseTo(expectedUnit, 8);
    }
    const composite = repeated.find((candidate) => candidate.sasche!.skuPatternIds!.length > 1);
    if (composite) expect(composite.sasche!.sourceRows.length).toBe(composite.sasche!.skuPatternIds!.length);
    expect(repeated.some((candidate) => candidate.sasche!.skuPatternIds!.length > 1 || candidate.sasche!.patternCount > 1)).toBe(true);
  });

  it("selects an API Y candidate after a non-1.12 markup override", async () => {
    const admin = await createUser({
      email: "api-markup-admin@kanei-trade.co.jp",
      name: "Kanai API Admin",
      password: "kanai-api-markup-password",
      role: "admin",
    });
    for (const dimension of [
      { laneCount: 1 as const, printTierM: 4000 as const },
      { laneCount: 2 as const, printTierM: 2000 as const },
      { laneCount: 2 as const, printTierM: 4000 as const },
    ]) {
      await createGravureYMasterRow(validateGravureYMasterInput({
        ...yInput,
        ...dimension,
      }), admin.email);
    }
    const session = await createSession(admin.id);
    const request = {
      method: "POST",
      headers: { cookie: `pouch_session=${session.token}` },
    };
    const recommendationResponse = await calculatePost(new Request(
      "http://localhost/api/calculate",
      { ...request, body: JSON.stringify(gravureRequest) },
    ));
    expect(recommendationResponse.status).toBe(200);
    const recommendation = await recommendationResponse.json();
    const candidate = recommendation.candidates.find((item: {
      route: string;
      sasche?: { sourceRows: Array<{ sellerMarkup: string }> };
    }) => item.route === "Y" && item.sasche?.sourceRows.some((row) => row.sellerMarkup === "1.25"));
    expect(candidate).toBeDefined();
    expect(recommendation.returnedProjection.selectedCandidateId).toBe("");

    const selectedResponse = await calculatePost(new Request(
      "http://localhost/api/calculate",
      {
        ...request,
        body: JSON.stringify({
          ...gravureRequest,
          selectedCandidateId: candidate.id,
          selectedCandidateTargetMargins: ["0.3"],
        }),
      },
    ));
    expect(selectedResponse.status).toBe(200);
    const selected = await selectedResponse.json();
    expect(selected.result.selectedCandidateId).toBe(candidate.id);
    expect(selected.originalResult.selectedCandidateId).toBe("");
  });

  it("covers every K source key one-to-one and derives current calculation parameters", async () => {
    const source = defaultGravureKSource();
    expect(Object.keys(source).sort()).toEqual([...GRAVURE_K_SOURCE_FIELDS].sort());
    const derived = deriveGravureKParameters(source);
    expect(derived).toEqual(defaultGravureRollParameters());
    expect(derived.petUnitPriceYenPerKg).toBe("505.8823529411764705882352941176470588235");
    await createGravureKMasterRow({
      source: { ...source, petPriceKrwPerKg: "5000", krwPer100Yen: "500" },
      effectiveFrom: "2026-10-01",
    }, "kanai@kanei-trade.co.jp");
    const resolved = await (await import("@/lib/gravure-price-store")).resolveGravureMasters("2026-10-11");
    expect(resolved.kSet?.source.petPriceKrwPerKg).toBe("5000");
    expect(resolved.kSet?.derived.petUnitPriceYenPerKg).toBe("1000");
    await expect(createGravureKMasterRow({
      source: { ...source },
      effectiveFrom: "2026-10-02",
    }, "kanai@kanei-trade.co.jp")).rejects.toThrow(/overlap/i);
  });

  it("rejects overlapping Y writes transactionally", async () => {
    await expect(createGravureYMasterRow(validateGravureYMasterInput({
      ...yInput,
      supplierUnitPriceYenPerM: "999",
      effectiveFrom: "2026-10-02",
    }), "kanai@kanei-trade.co.jp")).rejects.toThrow(/overlap/i);
  });

  it("serializes concurrent Y writes to the same effective interval", async () => {
    const attempts = Promise.allSettled([
      createGravureYMasterRow(validateGravureYMasterInput({
        ...yInput,
        webWidthMm: 620,
        laneCount: 1,
        printTierM: 4000,
        supplierUnitPriceYenPerM: "160.00",
        effectiveFrom: "2028-01-01",
        effectiveTo: "2028-12-31",
      }), "kanai@kanei-trade.co.jp"),
      createGravureYMasterRow(validateGravureYMasterInput({
        ...yInput,
        webWidthMm: 620,
        laneCount: 1,
        printTierM: 4000,
        supplierUnitPriceYenPerM: "161.00",
        effectiveFrom: "2028-01-01",
        effectiveTo: "2028-12-31",
      }), "kanai@kanei-trade.co.jp"),
    ]);
    const [first, second] = await attempts;
    void first;
    void second;
    const outcomes = [first, second].map((outcome) => outcome.status);
    expect(outcomes.sort()).toEqual(["fulfilled", "rejected"]);
    const rejection = [first, second].find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(String(rejection.reason)).toMatch(/overlap/i);
  });

  it("rejects repeated Y and K supersede operations without changing the original successor", async () => {
    const yOriginal = await createGravureYMasterRow(validateGravureYMasterInput({
      ...yInput,
      webWidthMm: 476,
      laneCount: 1,
      printTierM: 4000,
      effectiveFrom: "2029-01-01",
    }), "kanai@kanei-trade.co.jp");
    const yReplacement = await supersedeGravureYMasterRow(
      yOriginal.id,
      validateGravureYMasterInput({
        ...yInput,
        webWidthMm: 476,
        laneCount: 1,
        printTierM: 4000,
        supplierUnitPriceYenPerM: "151.00",
        effectiveFrom: "2029-02-01",
      }),
      "kanai@kanei-trade.co.jp",
    );
    const yRejection = await supersedeGravureYMasterRow(
      yOriginal.id,
      validateGravureYMasterInput({
        ...yInput,
        webWidthMm: 476,
        laneCount: 1,
        printTierM: 4000,
        supplierUnitPriceYenPerM: "152.00",
        effectiveFrom: "2029-03-01",
      }),
      "kanai@kanei-trade.co.jp",
    ).catch((caught: unknown) => caught);
    expect(yRejection).toBeInstanceOf(GravureValidationError);
    expect((yRejection as Error).message).toBe("already_superseded");

    const kSource = defaultGravureKSource();
    const kRowsBefore = await listGravureKMasterRows();
    const kOriginal = kRowsBefore[0];
    const kReplacement = await supersedeGravureKMasterRow(
      kOriginal.id,
      {
        source: { ...kSource, petPriceKrwPerKg: "6000", krwPer100Yen: "500" },
      effectiveFrom: "2030-01-01",
      },
      "kanai@kanei-trade.co.jp",
    );
    const kRejection = await supersedeGravureKMasterRow(
      kOriginal.id,
      {
        source: { ...kSource, petPriceKrwPerKg: "7000", krwPer100Yen: "500" },
        effectiveFrom: "2030-02-01",
      },
      "kanai@kanei-trade.co.jp",
    ).catch((caught: unknown) => caught);
    expect(kRejection).toBeInstanceOf(GravureValidationError);
    expect((kRejection as Error).message).toBe("already_superseded");

    const [yRows, kRows] = await Promise.all([listGravureYMasterRows(), listGravureKMasterRows()]);
    const storedYOriginal = yRows.find((row) => row.id === yOriginal.id);
    const storedYReplacement = yRows.find((row) => row.id === yReplacement.id);
    const storedKOriginal = kRows.find((row) => row.id === kOriginal.id);
    const storedKReplacement = kRows.find((row) => row.id === kReplacement.id);
    expect(storedYOriginal?.supersededById).toBe(yReplacement.id);
    expect(storedYReplacement?.supersededById).toBeNull();
    expect(storedKOriginal?.supersededById).toBe(kReplacement.id);
    expect(storedKReplacement?.supersededById).toBeNull();
  });

  it("fails closed for production master writes without a PostgreSQL URL", async () => {
    const previousEnvironment = process.env.NODE_ENV;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousPostgresUrl = process.env.POSTGRES_URL;
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    try {
      await expect(createGravureYMasterRow(validateGravureYMasterInput({
        ...yInput,
        effectiveFrom: "2027-01-01",
      }), "kanai@kanei-trade.co.jp")).rejects.toThrow("durable_database_required");
    } finally {
      Object.assign(process.env, { NODE_ENV: previousEnvironment });
      if (previousDatabaseUrl != null) process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousPostgresUrl != null) process.env.POSTGRES_URL = previousPostgresUrl;
    }
  });

  it("creates a reconstructable immutable snapshot and persists an authoritative quotation", async () => {
    const admin = await createUser({
      email: "second-kanai@kanei-trade.co.jp",
      name: "Snapshot Admin",
      password: "snapshot-admin-password",
      role: "admin",
    });
    const user = await createUser({
      email: "seven@example.com",
      name: "Seven User",
      password: "seven-user-password",
      role: "user",
    });
    const adminSession = await createSession(admin.id);
    const userSession = await createSession(user.id);
    const { POST: calculatePost } = await import("@/app/api/calculate/route");
    const body = JSON.stringify(gravureRequest);
    const adminResponse = await calculatePost(new Request("http://localhost/api/calculate", {
      method: "POST", body, headers: { cookie: `pouch_session=${adminSession.token}` },
    }));
    const adminPayload = await adminResponse.json();
    if (adminResponse.status !== 200) console.error("admin calculate failure", adminPayload);
    expect(adminResponse.status).toBe(200);
    expect(adminPayload.result.audit.calculationVersion).toBe("2026-10.2-gravure-master");
    expect(adminPayload.pricingSnapshot.id).toBeTruthy();
    expect(adminPayload.calculationRequest.gravureYRows).toHaveLength(12);
    expect(adminPayload.calculationRequest.gravureParameters.petUnitPriceYenPerKg).toBeTruthy();
    expect(adminPayload.returnedProjection.publicProjectionHash).toBeTruthy();
    expect(adminPayload.returnedProjection.pricingSnapshot.id).toBe(adminPayload.pricingSnapshot.id);

    const userResponse = await calculatePost(new Request("http://localhost/api/calculate", {
      method: "POST", body, headers: { cookie: `pouch_session=${userSession.token}` },
    }));
    expect(userResponse.status).toBe(200);
    const userPayload = await userResponse.json();
    const serialized = JSON.stringify(userPayload);
    for (const forbidden of ["supplierUnitPriceYenPerM", "sellerMarkup", "plateBaseYenPerColor", "petPriceKrwPerKg", "sourceRows"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(userPayload.publicProjectionHash).toBeTruthy();

    const snapshot = await getGravureSnapshot(adminPayload.pricingSnapshot.id)!;
    expect(snapshot).toBeTruthy();
    expect(() => verifyGravureSnapshot(snapshot!)).not.toThrow();
    expect(snapshot!.fullAugmentedCalculationRequest.spec.sizeKey).toBe("tube-35x80");
    expect(snapshot!.fullCalculationResult.audit.resultJsonSha256).toBe(snapshot!.calculationResultSha256);
    expect(snapshot!.yRows).toHaveLength(12);
    expect(snapshot!.kSource.petPriceKrwPerKg).toBe("5000");
    expect(snapshot!.kSource.krwPer100Yen).toBe("500");
    expect(snapshot!.kDerived.petUnitPriceYenPerKg).toBe("1000");

    const { POST: quotationPost } = await import("@/app/api/quotations/route");
    const projection = { ...userPayload };
    const publicProjection: Record<string, unknown> = { ...projection };
    delete (publicProjection as Record<string, unknown>).publicProjectionHash;
    await (await import("@/lib/gravure-price-store")).verifyGravureSnapshotIssuance({
      snapshotId: userPayload.pricingSnapshot.id,
      snapshotSha256: userPayload.pricingSnapshot.sha256,
      publicProjection: { ...publicProjection, publicProjectionHash: userPayload.publicProjectionHash },
    });
    const quotation = {
      quotationNumber: "G-SNAPSHOT-1",
      status: "draft",
      issueDate: "2026-10-11",
      validUntil: "2026-11-11",
      customerName: "Test Customer",
      customerContact: "",
      productName: "Gravure",
      sizeSummary: "35x80",
      quantity: "999",
      fillingCostPerPiece: "999",
      filmCostPerPiece: "999",
      filmMeterPrice: "999",
      filmOrderLengthM: "999",
      targetMargin: "0.3",
      taxRatePercent: "10",
      pricePerPiece: "999",
      subtotal: "999",
      tax: "99",
      grandTotal: "1098",
      deliveryDate: "",
      paymentTerms: "",
      notes: "",
      calculationVersion: "2026-10.2-gravure-master",
      resultHash: userPayload.resultHash,
      payload: {
        customerPostalCode: "1234567",
        customerTelephone: "0000000000",
        customerAddress: "Osaka",
        customerEmail: "customer@gravure.test",
        pricingSnapshot: {
          id: userPayload.pricingSnapshot.id,
          sha256: userPayload.pricingSnapshot.sha256,
          publicProjection: { ...publicProjection, publicProjectionHash: userPayload.publicProjectionHash },
        },
      },
    };
    const previousFlag = process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED;
    process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = "false";
    const disabled = await quotationPost(quotationIssuanceRequest(quotation, userSession.token));
    expect(disabled.status).toBe(503);
    await expect(disabled.json()).resolves.toEqual({ error: "gravure_snapshot_issuance_disabled" });
    process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = previousFlag ?? "true";
    const issued = await quotationPost(quotationIssuanceRequest(quotation, userSession.token));
    expect(issued.status).toBe(201);
    const record = (await issued.json()).record;
    expect(record.resultHash).toBe(userPayload.resultHash);
    expect(record.payload.pricingSnapshot.id).toBe(userPayload.pricingSnapshot.id);
    expect(record.payload.pricingSnapshot.publicProjection).toEqual(publicProjection);
    expect(record.payload).not.toHaveProperty("calculationRequest");
    expect(record.payload).not.toHaveProperty("purchaseOrder");
    expect(JSON.stringify(record.payload)).not.toContain("supplierUnitPriceYenPerM");

    // Kanai full data is for internal display; issuance still uses the server
    // canonical projection, proving both role projection contracts coexist.
    const kanaiQuotation: Record<string, unknown> = {
      ...quotation,
      quotationNumber: "G-SNAPSHOT-KANAI-1",
      resultHash: adminPayload.result.audit.resultJsonSha256,
    };
    kanaiQuotation.payload = {
      ...quotation.payload,
      pricingSnapshot: {
        id: adminPayload.pricingSnapshot.id,
        sha256: adminPayload.pricingSnapshot.sha256,
        publicProjection: adminPayload.returnedProjection,
      },
    };
    const kanaiIssued = await quotationPost(quotationIssuanceRequest(kanaiQuotation, adminSession.token));
    expect(kanaiIssued.status).toBe(201);
    const kanaiRecord = (await kanaiIssued.json()).record;
    expect(kanaiRecord.payload.pricingSnapshot.id).toBe(adminPayload.pricingSnapshot.id);
    const kanaiStoredProjection = { ...adminPayload.returnedProjection };
    delete kanaiStoredProjection.publicProjectionHash;
    expect(kanaiRecord.payload.pricingSnapshot.publicProjection).toEqual(kanaiStoredProjection);

    await expect(verifyGravureSnapshotIssuance({
      snapshotId: userPayload.pricingSnapshot.id,
      snapshotSha256: userPayload.pricingSnapshot.sha256,
      publicProjection: { ...publicProjection, publicProjectionHash: "0".repeat(64) },
    })).rejects.toThrow("pricing_projection_hash_invalid");

    const oldBypass: Record<string, unknown> = { ...quotation, quotationNumber: "G-OLD-BYPASS-1" };
    oldBypass.calculationVersion = "legacy";
    oldBypass.payload = {
      ...quotation.payload,
      pricingSnapshot: undefined,
      calculationRequest: { ...gravureRequest, gravureYRows: [] },
    };
    const oldBypassResponse = await quotationPost(quotationIssuanceRequest(oldBypass, userSession.token));
    expect(oldBypassResponse.status).toBe(400);
    await expect(oldBypassResponse.json()).resolves.toEqual({ error: "pricing_snapshot_required" });

    const tampered: Record<string, unknown> = { ...quotation, quotationNumber: "G-SNAPSHOT-2" };
    const tamperedProjection = { ...publicProjection, quantity: "1" };
    tampered.payload = {
      ...quotation.payload,
      pricingSnapshot: {
        ...(quotation.payload.pricingSnapshot as Record<string, unknown>),
        publicProjection: tamperedProjection,
      },
    };
    const rejected = await quotationPost(quotationIssuanceRequest(tampered, userSession.token));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ error: "pricing_snapshot_invalid" });
  });

  it("binds the result hash to governed request identity, not summary values alone", async () => {
    const baseRequest: CalculationInput = {
      ...gravureRequest,
      recommendationMode: false,
      selectedCandidateId: "",
    };
    const baseline = calculatePouchCost({ ...baseRequest, gravureYRows: [] });
    const governed = calculatePouchCost({
      ...baseRequest,
      gravureYRows: [{
        id: 999999,
        webWidthMm: 356,
        laneCount: 1,
        printTierM: 2000,
        approxOutputLengthM: "1700",
        supplierUnitPriceYenPerM: "141.00",
        plateBaseYenPerColor: "26000",
        sellerMarkup: "1.120000",
        effectiveFrom: "2026-10-01",
        effectiveTo: "2099-12-31",
      }],
    });
    expect(governed.film.filmTotal).toBe(baseline.film.filmTotal);
    expect(governed.totalCostPerPiece).toBe(baseline.totalCostPerPiece);
    expect(governed.audit.governedInputJson).not.toBe(baseline.audit.governedInputJson);
    expect(governed.audit.resultJsonSha256).not.toBe(baseline.audit.resultJsonSha256);
  });
});

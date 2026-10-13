import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "gravure-ui-slice-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "kanai@kanei-trade.co.jp";
process.env.ADMIN_PASSWORD = "kanai-ui-password";
process.env.ADMIN_NAME = "Kanai UI Admin";

const { isReturnedPublicProjection } = await import("@/app/simulator-client");
const { createGravureYMasterRow, listGravureMasterAudit, listGravureSnapshotAuditRecords, saveGravureSnapshot, validateGravureYMasterInput } = await import("@/lib/gravure-price-store");
const { calculatePouchCost } = await import("@/lib/calculation");
const { defaultGravureRollParameters } = await import("@/lib/gravure-roll");
const { createUser, createSession } = await import("@/lib/auth-store");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const redactedProjection = {
  pricingSnapshot: {
    id: "0197aaaa-bbbb-7ccc-8ddd-eeeeffff0001",
    sha256: "a".repeat(64),
    resolverVersion: "gravure-pricing-master-v1",
    asOf: "2026-10-11",
    view: "redacted" as const,
  },
  calculationVersion: "2026-10.2-gravure-master",
  printingMethod: "gravure",
  quantity: "500000",
  connectedChambers: 1,
  fillingMethod: "hopper",
  size: { widthMm: "35", lengthMm: "80" },
  selectedCandidateId: "Y-356-1-2000-500000",
  resultHash: "b".repeat(64),
  publicProjectionHash: "c".repeat(64),
  candidates: [{
    id: "Y-356-1-2000-500000",
    route: "Y",
    printingMethod: "gravure",
    detailLabel: "Y 1,700m",
    materialText: "PET",
    colorText: "2色",
    compositionText: "composition",
    pouchSpecText: "pouch",
    patternText: "1 pattern",
    adjustedQuantity: "500000",
    capacityQuantity: "500000",
    adjustedSkuQuantities: ["250000", "250000"],
    requiredLengthM: "1000",
    orderLengthM: "1700",
    effectiveLengthM: "1700",
    filmTotalYen: "300000",
    filmCostPerPieceYen: "0.6",
    allInCostPerPieceYen: "1.2",
  }],
};

describe("G010-G015 admin and simulator slice", () => {
  it("proves digital remains UTC while Y resolution uses the JST boundary date", async () => {
    const { upsertFilmPrice, resolveFilmUnitPrices } = await import("@/lib/film-price-store");
    const { defaultParameters } = await import("@/lib/constants");
    const { tokyoDate } = await import("@/lib/gravure-price-store");
    const boundary = new Date("2026-10-10T15:30:00Z");
    await upsertFilmPrice({
      band: "lte570",
      tier: "500",
      unitPriceYenPerM: "777",
      effectiveFrom: "2026-10-10",
      effectiveTo: "2026-10-10",
      memo: "UTC legacy boundary",
    }, "boundary-test");
    await createGravureYMasterRow(validateGravureYMasterInput({
      webWidthMm: 556,
      laneCount: 1,
      printTierM: 2000,
      approxOutputLengthM: "1700",
      supplierUnitPriceYenPerM: "222.22",
      plateBaseYenPerColor: "28000",
      sellerMarkup: "1.15",
      effectiveFrom: "2026-10-11",
      effectiveTo: "2026-10-11",
      memo: "JST boundary",
    }), "boundary-test@kanei-trade.co.jp");
    const digital = await resolveFilmUnitPrices(boundary.toISOString().slice(0, 10), defaultParameters.filmUnitPrices);
    expect(digital.lte570["500"]).toBe("777");
    const resolved = await (await import("@/lib/gravure-price-store")).resolveGravureMasters(tokyoDate(boundary));
    expect(resolved.asOf).toBe("2026-10-11");
    expect(resolved.yRows.some((row) => row.supplierUnitPriceYenPerM === "222.22")).toBe(true);
  });

  it("keeps gravure validation errors generic and non-redacting for Seven", async () => {
    const seven = await createUser({
      email: "seven-error@example.com", name: "Seven Error", password: "seven-error-password", role: "user",
    });
    const session = await createSession(seven.id);
    const { POST } = await import("@/app/api/calculate/route");
    const response = await POST(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({ ...redactedProjection, spec: { skuCount: 0 }, quantity: "-1", printingMethod: "gravure" }),
      headers: { cookie: `pouch_session=${session.token}` },
    }));
    expect(response.status).toBe(400);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toMatch(/supplierUnitPrice|sellerMarkup|plateBase|petPriceKrw|sourceRows|snapshotSha256/);
  });

  it("renders the five Kanai tabs and every grouped K source field", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => Response.json(
      url.toString().includes("gravure-k") ? { parameterSets: [] }
        : url.toString().includes("gravure-y") ? { prices: [] }
          : url.toString().includes("gravure-audit") ? { audit: [], snapshots: [] }
            : { prices: [] },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const Client = (await import("@/app/admin/film-prices/film-prices-client")).default;
    const user = userEvent.setup();
    render(<Client />);
    for (const tab of ["Digital", "Gravure Y", "Gravure K", "Rules", "Audit"]) {
      expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
    }
    expect(screen.getByTestId("digital-precedence")).toHaveTextContent(/UTC.*explicit film unit prices/is);
    await user.click(screen.getByRole("tab", { name: "Gravure K" }));
    expect(screen.getByText("Lamination with AL (KRW/m)")).toBeInTheDocument();
    expect(screen.getByText("Lamination without AL (KRW/m)")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(21);
    await user.click(screen.getByRole("tab", { name: "Gravure Y" }));
    expect(screen.getByText(/Active rows replace only the matching width \+ lane \+ tier/)).toBeInTheDocument();
    expect(screen.getByTestId("y-seller-markup")).toHaveValue("1.12");
    await user.click(screen.getByRole("tab", { name: "Audit" }));
    expect(screen.getByText("Master supersede history")).toBeInTheDocument();
    expect(screen.getByText("Source rows & snapshots")).toBeInTheDocument();
  });

  it("keeps Seven away from Y/K admin endpoints while Kanai can sync K", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({});
    }));
    const { default: Simulator } = await import("@/app/simulator-client");
    const seven = render(<Simulator userRole="user" kanaiMasterAccess={false} />);
    await waitFor(() => expect(seven.getByTestId("server-result")).toHaveAttribute("data-state", "not_calculated"));
    expect(urls).not.toContain("/api/film-prices/gravure/k");
    expect(urls).not.toContain("/api/film-prices/gravure/y");
    cleanup();
    urls.length = 0;
    render(<Simulator userRole="admin" kanaiMasterAccess />);
    await waitFor(() => expect(urls.some((url) => url === "/api/film-prices/gravure/k")).toBe(true));
    expect(urls).not.toContain("/api/film-prices/gravure/y");
  });

  it("accepts only the returned public projection shape and rejects a sensitive extra field", () => {
    expect(isReturnedPublicProjection(redactedProjection)).toBe(true);
    const tampered = {
      ...redactedProjection,
      candidates: [{ ...redactedProjection.candidates[0], sellerMarkup: "1.25" }],
    } as unknown;
    expect(isReturnedPublicProjection(tampered)).toBe(false);
    const visibleKeys = Object.keys(redactedProjection).sort();
    expect(visibleKeys).toEqual(([
      "calculationVersion", "candidates", "connectedChambers", "fillingMethod",
      "printingMethod", "pricingSnapshot", "publicProjectionHash", "quantity",
      "resultHash", "selectedCandidateId", "size",
    ]).sort());
    expect(JSON.stringify(redactedProjection)).not.toMatch(/sellerMarkup|supplierUnitPrice|plateBase|petPriceKrw|sourceRows/);
  });

  it("lists audited source rows, supersede history, and full admin snapshots", async () => {
    const admin = await createUser({
      email: "audit-kanai@kanei-trade.co.jp", name: "Audit Kanai", password: "audit-kanai-password", role: "admin",
    });
    const outsider = await createUser({
      email: "seven@example.com", name: "Seven Outsider", password: "audit-seven-password", role: "admin",
    });
    const adminSession = await createSession(admin.id);
    const outsiderSession = await createSession(outsider.id);
    const row = await createGravureYMasterRow(validateGravureYMasterInput({
      webWidthMm: 476,
      laneCount: 2,
      printTierM: 4000,
      approxOutputLengthM: "7000",
      supplierUnitPriceYenPerM: "88.5",
      plateBaseYenPerColor: "31500",
      sellerMarkup: "1.18",
      effectiveFrom: "2027-04-01",
      effectiveTo: "2027-06-30",
      memo: "UI audit fixture",
    }), admin.email);
    const request = {
      spec: {
        sizeKey: "tube-35x80", customWidthMm: "35", customLengthMm: "80", fillMlPerChamber: "10",
        connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4, isCustom: false,
        colorCount: 2, bulkUnitPrice: "0", skuCount: 1,
      },
      quantity: "100000", printingMethod: "gravure", gravureParameters: defaultGravureRollParameters(),
      targetMargins: ["0.3"], recommendationMode: true, selectedCandidateId: "",
      selectedCandidateTargetMargins: ["0.3"],
    } as Parameters<typeof calculatePouchCost>[0];
    const result = calculatePouchCost({ ...request, gravureYRows: [row] });
    await saveGravureSnapshot({
      asOf: "2027-04-02", digitalValues: (await import("@/lib/constants")).defaultParameters.filmUnitPrices,
      resolved: { asOf: "2027-04-02", yRows: [row], kSet: null, fallbackVersions: { y: "supplier-matrix-2026-10", k: "gravure-roll-defaults-2026-10" } },
      request, result, createdBy: admin.email,
    });
    expect((await listGravureMasterAudit()).some((entry) => entry.action === "create" && (entry.after as { id?: number })?.id === row.id)).toBe(true);
    const snapshots = await listGravureSnapshotAuditRecords();
    expect(snapshots[0].yRows.map((snapshotRow) => snapshotRow.id)).toContain(row.id);
    expect(snapshots[0].kSource).toBeTruthy();
    const { GET } = await import("@/app/api/film-prices/gravure/audit/route");
    const denied = await GET(new Request("http://localhost/api/film-prices/gravure/audit", { headers: { cookie: `pouch_session=${outsiderSession.token}` } }));
    expect(denied.status).toBe(403);
    const response = await GET(new Request("http://localhost/api/film-prices/gravure/audit", { headers: { cookie: `pouch_session=${adminSession.token}` } }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.audit.some((entry: { rowId: number }) => entry.rowId === row.id)).toBe(true);
    expect(payload.snapshots.some((snapshot: { yRows: Array<{ id: number }> }) => snapshot.yRows.some((snapshotRow) => snapshotRow.id === row.id))).toBe(true);
  });
});

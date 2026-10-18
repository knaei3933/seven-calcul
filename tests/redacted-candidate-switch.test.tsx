import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import SimulatorClient from "@/app/simulator-client";
import type { ReturnedPublicProjection } from "@/lib/gravure-price-store";

const K1_ID = "K-1-412500";
const K2_ID = "K-2-825000-exact";
const K1_SKU_QUANTITIES = ["412000"];
const K2_SKU_QUANTITIES = ["825000"];

function projection(selectedCandidateId: string): ReturnedPublicProjection {
  const selectedK1 = selectedCandidateId === K1_ID;
  return {
    pricingSnapshot: {
      id: "0198aaaa-bbbb-7ccc-8ddd-eeeeffff0001",
      sha256: "a".repeat(64),
      resolverVersion: "gravure-pricing-master-v1",
      asOf: "2026-10-15",
      view: "redacted",
    },
    calculationVersion: "2026-10.2-gravure-master",
    printingMethod: "gravure",
    quantity: selectedK1 ? "412000" : "825000",
    connectedChambers: 1,
    fillingMethod: "hopper",
    size: { widthMm: "50", lengthMm: "90" },
    selectedCandidateId,
    resultHash: "b".repeat(64),
    publicProjectionHash: "c".repeat(64),
    candidates: [
      {
        id: K1_ID,
        route: "K",
        printingMethod: "gravure",
        detailLabel: K1_ID,
        materialText: "韓国輸入",
        colorText: "4色",
        adjustedQuantity: "412000",
        capacityQuantity: "412500",
        adjustedSkuQuantities: K1_SKU_QUANTITIES,
        requiredLengthM: "1000",
        orderLengthM: "1000",
        effectiveLengthM: "1000",
        filmTotalYen: "100000",
        filmCostPerPieceYen: "0.12",
        allInCostPerPieceYen: "0.20",
      },
      {
        id: K2_ID,
        route: "K",
        printingMethod: "gravure",
        detailLabel: K2_ID,
        materialText: "韓国輸入",
        colorText: "4色",
        adjustedQuantity: "825000",
        capacityQuantity: "825000",
        adjustedSkuQuantities: K2_SKU_QUANTITIES,
        requiredLengthM: "1000",
        orderLengthM: "1000",
        effectiveLengthM: "1000",
        filmTotalYen: "101000",
        filmCostPerPieceYen: "0.12",
        allInCostPerPieceYen: "0.21",
      },
    ],
  };
}

function candidateCard(detailLabel: string) {
  return screen.getByText(detailLabel).closest("article") as HTMLElement;
}

describe("redacted candidate switching", () => {
  afterEach(cleanup);

  it("regenerates the second candidate from the original input basis", async () => {
    const user = userEvent.setup();
    const calculateRequests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      calculateRequests.push(request);

      if (request.selectedCandidateId === K1_ID) {
        if (
          request.printingMethod !== "digital"
          || JSON.stringify(request.targetMargins) !== JSON.stringify(["0.3", "0.35", "0.4"])
          || request.quantity !== "524000"
          || JSON.stringify(request.spec.skuQuantities) !== JSON.stringify(["524000"])
          || JSON.stringify(request.selectedCandidateTargetMargins) !== JSON.stringify(["0.2", "0.25", "0.3"])
        ) {
          return Response.json({ error: "candidate_not_found" }, { status: 400 });
        }
        return Response.json(projection(K1_ID));
      }
      return Response.json(projection(K2_ID));
    }));

    render(<SimulatorClient />);
    await user.selectOptions(screen.getByLabelText("サイズ"), "tube-50x90");
    const quantity = screen.getByLabelText("発注数量 (枚)");
    await user.clear(quantity);
    await user.type(quantity, "524000");
    await user.click(screen.getByTestId("calculate-desktop"));

    await waitFor(() => expect(screen.getByTestId("redacted-snapshot")).toBeInTheDocument());
    expect(candidateCard(K2_ID)).toHaveClass("selected");

    await user.click(candidateCard(K1_ID).querySelector("button")!);

    await waitFor(() => expect(candidateCard(K1_ID)).toHaveClass("selected"));
    expect(candidateCard(K2_ID)).not.toHaveClass("selected");
    expect(screen.queryByTestId("candidate-selection-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("calculation-error")).not.toBeInTheDocument();
    expect(calculateRequests[0]).toMatchObject({
      quantity: "524000",
      selectedCandidateId: "",
    });
    expect(calculateRequests[1]).toMatchObject({
      printingMethod: "digital",
      quantity: "524000",
      selectedCandidateId: K1_ID,
    });
    expect(calculateRequests).toHaveLength(2);
  });
});

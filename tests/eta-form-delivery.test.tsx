import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import EtaFormClient from "@/app/film-orders/eta/[token]/eta-form-client";
import type { SupplierLocale } from "@/lib/film-order-access";
import type { FilmDeliveryTracking } from "@/lib/film-order-shared";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("eta form delivery report", () => {
  it("blocks shipment reporting until ship-to is confirmed", async () => {
    const user = userEvent.setup();
    const postBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/delivery-upload") && !init?.method) {
        return Response.json({ driveConfigured: true, folderConfigured: true });
      }
      if (init?.method === "POST") postBodies.push(JSON.parse(String(init.body)));
      return Response.json({});
    }));

    const delivery = {
      shippedOn: null,
      deliveredOn: null,
      documents: [],
    } as unknown as FilmDeliveryTracking;

    render(
      <EtaFormClient
        token="token"
        currentEtaDate=""
        currentNote=""
        delivery={delivery}
        locale={"ko" as SupplierLocale}
        shipToStatus="registered"
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("납품처가 아직 등록/확정되지 않았습니다");
    await user.type(screen.getByLabelText("출하일(필수)"), "2026-10-28");
    expect(screen.getByRole("button", { name: "보고 등록" })).toBeDisabled();
    expect(postBodies).toEqual([]);
  });

  it("sends kind=delivery when registering the delivered date", async () => {
    const user = userEvent.setup();
    let body: unknown;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (target.endsWith("/delivery-upload") && !init?.method) {
        return Response.json({ driveConfigured: true, folderConfigured: true });
      }
      if (init?.method === "POST") {
        body = JSON.parse(String(init.body));
        return Response.json({ order: { delivery: { shippedOn: "2026-10-28", deliveredOn: "2026-10-28" } } });
      }
      return Response.json({});
    }));

    const delivery = {
      shippedOn: "2026-10-28",
      deliveredOn: null,
      carrier: "EMS",
      trackingNumber: "",
      shipmentNote: "",
      deliveryNote: "",
      documents: [],
    } as unknown as FilmDeliveryTracking;

    render(<EtaFormClient token="token" currentEtaDate="" currentNote="" delivery={delivery} locale={"ko" as SupplierLocale} />);
    await waitFor(() => expect(screen.getByLabelText("납품일(필수)")).toHaveValue(""));
    await user.type(screen.getByLabelText("납품일(필수)"), "2026-10-28");
    await user.click(screen.getByRole("button", { name: "보고 등록" }));

    await waitFor(() => expect(body).toMatchObject({ kind: "delivery", date: "2026-10-28" }));
    expect(screen.getByRole("status")).toHaveTextContent("납품 보고를 등록했습니다");
  });
});

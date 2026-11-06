import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
const requirePageUserMock = vi.fn();
const canViewFilmOrdersMock = vi.fn();
const syncFilmOrdersMock = vi.fn();
const listEntriesMock = vi.fn();

vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/lib/page-auth", () => ({ requirePageUser: requirePageUserMock }));
vi.mock("@/lib/film-order-access", () => ({ canViewFilmOrders: canViewFilmOrdersMock }));
vi.mock("@/lib/film-orders", () => ({ syncFilmOrdersFromQuotations: syncFilmOrdersMock }));
vi.mock("@/lib/film-order-intake", () => ({ listFilmOrderIntakeEntries: listEntriesMock }));

describe("G001 internal film-order navigation", () => {
  it("redirects an authorized internal film-order request to data intake", async () => {
    redirectMock.mockClear();
    requirePageUserMock.mockResolvedValue({ email: "seven@727.co.jp", role: "user" });
    canViewFilmOrdersMock.mockReturnValue(true);
    syncFilmOrdersMock.mockResolvedValue(0);
    listEntriesMock.mockResolvedValue([]);
    const { default: FilmOrdersPage } = await import("@/app/film-orders/page");

    await expect(FilmOrdersPage()).rejects.toThrow("NEXT_REDIRECT:/data-intake");
    expect(requirePageUserMock).toHaveBeenCalledWith("/film-orders");
    expect(redirectMock).toHaveBeenCalledWith("/data-intake");
    expect(syncFilmOrdersMock).not.toHaveBeenCalled();
  });

  it("keeps unauthorized internal users on history without exposing intake", async () => {
    redirectMock.mockClear();
    requirePageUserMock.mockResolvedValue({ email: "other@example.test", role: "user" });
    canViewFilmOrdersMock.mockReturnValue(false);
    const { default: FilmOrdersPage } = await import("@/app/film-orders/page");

    await expect(FilmOrdersPage()).rejects.toThrow("NEXT_REDIRECT:/history");
    expect(redirectMock).toHaveBeenCalledWith("/history");
    expect(syncFilmOrdersMock).not.toHaveBeenCalled();
  });
});

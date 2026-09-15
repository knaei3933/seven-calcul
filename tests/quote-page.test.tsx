import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuotePage from "@/app/quote/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("quotation page stale draft", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps direct manual entry actions available when no stale marker exists", async () => {
    render(<QuotePage />);

    await waitFor(() => {
      expect(screen.getByTestId("save-history")).toBeEnabled();
      expect(screen.getByTestId("print-pdf")).toBeEnabled();
      expect(screen.getByTestId("open-checklist")).toBeEnabled();
    });
    expect(screen.queryByTestId("stale-quote-warning")).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows a warning and blocks linked quotation actions while the simulator draft is stale", async () => {
    sessionStorage.setItem("pouch-simulator-stale-status-v1", "input-changed");
    render(<QuotePage />);

    await waitFor(() => expect(screen.getByTestId("stale-quote-warning")).toBeVisible());
    expect(screen.getByTestId("save-history")).toBeDisabled();
    expect(screen.getByTestId("print-pdf")).toBeDisabled();
    expect(screen.getByTestId("open-checklist")).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

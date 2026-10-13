import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const Client = (await import("@/app/admin/film-prices/film-prices-client")).default;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function successfulResponses() {
  return vi.fn(async (url: RequestInfo | URL) => Response.json(
    url.toString().includes("gravure-k") ? { parameterSets: [] }
      : url.toString().includes("gravure-y") ? { prices: [] }
        : url.toString().includes("gravure-audit") ? { audit: [], snapshots: [] }
          : { prices: [] },
  ));
}

describe("film price admin transport failures", () => {
  it("shows a stable load error when an initial request disconnects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("secret load transport failure");
    }));

    render(<Client />);

    expect(await screen.findByText(
      "単価マスタを読み込めませんでした。ネットワークを確認して、もう一度お試しください。",
    )).toBeInTheDocument();
    expect(screen.getByTestId("gravure-master-unavailable")).toBeInTheDocument();
  });

  it("shows a stable save error and re-enables saving after a request disconnects", async () => {
    const fetchMock = successfulResponses();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Client />);

    const price = await screen.findByLabelText("570mm以下 〜999m");
    await user.clear(price);
    await user.type(price, "999");
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("secret save transport failure");
    });
    await user.click(screen.getByRole("button", { name: "変更を保存" }));

    expect(await screen.findByText(
      "通信エラーにより保存できませんでした。もう一度お試しください。",
    )).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "変更を保存" })).toBeEnabled());
    expect(screen.queryByText(/secret .* transport failure/)).not.toBeInTheDocument();
  });
});

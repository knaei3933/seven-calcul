import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import QuotationPage from "@/app/page";

describe("quotation UI", () => {
  it("calculates the valid default condition and keeps cost details outside customer preview", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    await user.click(screen.getByRole("button", { name: "計算して確定" }));
    expect(await screen.findByText("サーバー確定")).toBeInTheDocument();
    expect(screen.getByTestId("bulk-usage").textContent).toContain("392,000 ml");
    expect(screen.getByTestId("customer-total")).not.toHaveTextContent("原価");
    expect(screen.queryByTestId("customer-commission")).not.toBeInTheDocument();
  });

  it("blocks calculation when an SKU is below 300m", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    await user.clear(screen.getByLabelText("SKU2必要長さ (m)"));
    await user.type(screen.getByLabelText("SKU2必要長さ (m)"), "50");
    expect(screen.getByRole("alert").textContent).toContain("確定見積不可");
    expect(screen.getByRole("button", { name: "計算して確定" })).toBeDisabled();
  });
});

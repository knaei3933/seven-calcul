import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginForm from "@/app/login/login-form";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

describe("login form", () => {
  beforeEach(() => {
    replace.mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("provides accessible inputs, redirects after login, and preserves the safe next path", async () => {
    const fetchMock = vi.fn(async () => Response.json({ user: { id: 1, email: "user@example.test" } }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginForm next="/history" />);
    const user = userEvent.setup();
    expect(screen.getByLabelText("メールアドレス")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("パスワード")).toHaveAttribute("type", "password");

    await user.type(screen.getByLabelText("メールアドレス"), "user@example.test");
    await user.type(screen.getByLabelText("パスワード"), "user-login-password");
    await user.click(screen.getByTestId("login-submit"));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/history"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ method: "POST" }));
  });

  it("shows a generic error without revealing whether email or password failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_credentials" }, { status: 401 })));
    render(<LoginForm next="/" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("メールアドレス"), "wrong@example.test");
    await user.type(screen.getByLabelText("パスワード"), "wrong-login-password");
    await user.click(screen.getByTestId("login-submit"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("メールアドレスまたはパスワードが正しくありません。");
    expect(replace).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import contract from "../contracts/portal-api-v1.json" with { type: "json" };
import * as loginRoute from "../src/app/api/portal/v1/auth/login/route";
import * as logoutRoute from "../src/app/api/portal/v1/auth/logout/route";
import * as registerRoute from "../src/app/api/portal/v1/auth/register/route";
import * as resendRoute from "../src/app/api/portal/v1/auth/resend/route";
import * as verifyRoute from "../src/app/api/portal/v1/auth/verify/route";
import * as meRoute from "../src/app/api/portal/v1/me/route";

const protectedRoutes = [
  { method: "POST", path: "/auth/register", handler: registerRoute.POST },
  { method: "POST", path: "/auth/verify", handler: verifyRoute.POST },
  { method: "POST", path: "/auth/resend", handler: resendRoute.POST },
  { method: "POST", path: "/auth/login", handler: loginRoute.POST },
  { method: "POST", path: "/auth/logout", handler: logoutRoute.POST },
  { method: "GET", path: "/me", handler: meRoute.GET },
] as const;

describe("portal v1 Next route inventory", () => {
  it("matches the G003 subset of the checksummed v1 route contract", () => {
    const inventory = contract.routeInventory.routes
      .filter((route) => [
        "/auth/register",
        "/auth/verify",
        "/auth/resend",
        "/auth/login",
        "/auth/logout",
        "/me",
      ].includes(route.path))
      .map((route) => `${route.method} ${route.path}`);
    expect(inventory).toEqual(protectedRoutes.map((route) => `${route.method} ${route.path}`));
  });

  it("requires the service bearer token at every Next.js boundary", async () => {
    for (const route of protectedRoutes) {
      const request = new Request("https://admin.test/api/portal/v1", {
        method: route.method,
        headers: route.method === "POST"
          ? { "content-type": "application/json" }
          : undefined,
        body: route.method === "POST" ? "{}" : undefined,
      });
      const response = await route.handler(request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });
});

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ }, testInfo) => {
  test.skip(testInfo.project.name !== "kanai-chromium", "Full completion chain runs once as Kanei desktop.");
});

test("data-intake UI completes PO mail and delivery-note PDF after dual approval", async ({ browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const customer = `Completion UI ${stamp}`;
  const makerCode = `CMP${stamp.toString(36).toUpperCase()}`;
  const seven = { email: `completion-seven-${stamp}@727.co.jp`, password: "completion-seven-password", name: "Completion Seven Owner" };

  const kanaiContext = await browser.newContext({ storageState: "/tmp/pouch-playwright-kanai-state.json" });
  const kanaiPage = await kanaiContext.newPage();
  const api = async (page: typeof kanaiPage, path: string, init: Parameters<typeof page.request.fetch>[1] = {}) => {
    const response = await page.request.fetch(`http://127.0.0.1:3101${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", origin: "http://127.0.0.1:3101", ...(init.headers ?? {}) },
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status(), ok: response.ok(), payload };
  };

  // Create the Seven quote owner from the Kanei admin session.
  const createdUser = await api(kanaiPage, "/api/users", {
    method: "POST",
    data: JSON.stringify({
      email: seven.email, name: seven.name, password: seven.password, role: "user", isActive: true,
    }),
  });
  expect(createdUser.status).toBe(201);

  const sevenContext = await browser.newContext();
  const sevenPage = await sevenContext.newPage();
  await sevenContext.clearCookies();
  await sevenPage.goto("/login?next=%2F", { waitUntil: "domcontentloaded" });
  await expect(sevenPage).toHaveURL(/\/login/u);
  await sevenPage.getByTestId("login-email").fill(seven.email);
  await sevenPage.getByTestId("login-password").fill(seven.password);
  await sevenPage.getByTestId("login-submit").click();
  await sevenPage.getByTestId("current-user").waitFor({ timeout: 20_000 });

  // The quote owner's customer master must exist before delivery-destination registration.
  const createdCustomer = await api(sevenPage, "/api/customers", {
    method: "POST",
    data: JSON.stringify({
      customerCode: "TEST-0001", customerName: customer, customerPostalCode: "100-0001",
      customerAddress: "Tokyo Test 1-1-1", customerContact: "Completion Taro",
      customerTelephone: "03-0000-0000", customerEmail: "completion@example.test",
    }),
  });
  expect(createdCustomer.status).toBe(201);

  // UI: simulator → candidate → quote.
  await sevenPage.goto("/");
  await sevenPage.getByLabel("サイズ").selectOption("tube-50x90");
  await sevenPage.getByLabel("発注数量 (枚)").fill("50000");
  await sevenPage.getByTestId("calculate-desktop").click();
  const modal = sevenPage.getByTestId("recommendation-modal-overlay");
  await modal.waitFor({ timeout: 30_000 });
  await modal.locator(".recommendation-card").filter({ hasText: "D / デジタル" }).first().click();
  await modal.waitFor({ state: "hidden", timeout: 30_000 });
  await sevenPage.locator("header a", { hasText: "見積書発行" }).click();
  await sevenPage.getByTestId("issue-required-fields").waitFor({ timeout: 30_000 });
  await sevenPage.getByTestId("fill-test-data").click();
  await sevenPage.getByPlaceholder("株式会社◯◯").fill(customer);
  await sevenPage.getByTestId("save-history").click();
  const issueSuccess = await sevenPage.getByTestId("issue-success").textContent({ timeout: 30_000 });
  const quoteNumber = issueSuccess?.match(/S7-[A-Z0-9-]+/u)?.[0];
  expect(quoteNumber).toBeTruthy();

  // UI: internal approval transfers the quote into data-intake.
  await sevenPage.goto("/history");
  await sevenPage.getByTestId("history-search").fill(customer);
  const historyRow = sevenPage.getByTestId("history-table").getByRole("row").filter({ hasText: customer }).first();
  await historyRow.waitFor({ timeout: 30_000 });
  await historyRow.getByRole("button", { name: "詳細" }).click();
  const internalApprovalResponse = sevenPage.waitForResponse(
    (response) => response.url().includes("/api/quotations/") && response.url().endsWith("/approvals"),
    { timeout: 60_000 },
  );
  await sevenPage.getByTestId("history-internal-approve").click();
  const internalApproval = await internalApprovalResponse;
  expect(internalApproval.ok()).toBeTruthy();
  await expect(sevenPage.getByText(`${quoteNumber} を内部承認しました。`)).toBeVisible({ timeout: 30_000 });

  // UI: data-intake exposes the upload panel for the quote owner.
  await sevenPage.goto("/data-intake");
  await sevenPage.getByTestId("intake-search").fill(customer);
  await sevenPage.getByTestId("intake-apply").click();
  const intakeRow = sevenPage.getByTestId("intake-row").filter({ hasText: customer }).first();
  await intakeRow.waitFor({ timeout: 30_000 });
  await intakeRow.getByTestId("intake-action-intake_upload").click();
  await expect(sevenPage.getByTestId("intake-upload-submit")).toBeVisible();

  // Setup the maker/proof workflow through authorized APIs; external Google Drive objects are intentionally not used here.
  const list = await api(sevenPage, `/api/data-intake?search=${encodeURIComponent(customer)}`);
  const entry = list.payload?.entries?.find((item: { customerName: string }) => item.customerName === customer);
  expect(entry?.filmOrder?.id).toBeTruthy();
  const orderId = entry.filmOrder.id;

  const maker = await api(kanaiPage, "/api/film-makers", {
    method: "POST",
    data: JSON.stringify({
      makerCode, companyName: "Completion UI Maker", contactName: "Maker Taro",
      email: `completion-maker-${stamp}@example.test`, language: "ko", printMethod: "digital",
      procurementRoute: "K", isActive: true, note: "data-intake UI completion",
    }),
  });
  expect(maker.status).toBe(201);
  const makerId = maker.payload.maker.id;

  let response = await api(sevenPage, `/api/film-orders/${orderId}`, { method: "POST", data: JSON.stringify({ action: "mark-ordered", origin: "http://127.0.0.1:3101" }) });
  expect(response.ok).toBeTruthy();
  response = await api(kanaiPage, `/api/film-orders/${orderId}`, { method: "POST", data: JSON.stringify({ action: "select-film-maker", makerId, origin: "http://127.0.0.1:3101" }) });
  expect(response.ok).toBeTruthy();
  response = await api(sevenPage, `/api/film-orders/${orderId}`, { method: "POST", data: JSON.stringify({ action: "set-customer-design-not-required", reason: "completion UI audit", origin: "http://127.0.0.1:3101" }) });
  expect(response.ok).toBeTruthy();
  response = await api(sevenPage, `/api/film-orders/${orderId}`, {
    method: "POST",
    data: JSON.stringify({
      action: "register-receiving", aiFileName: "completion-ui.ai", aiFileUrl: "http://127.0.0.1:3101/completion-ui.ai",
      pdfFileName: "completion-ui.pdf", pdfFileUrl: "http://127.0.0.1:3101/completion-ui.pdf",
      guideAcknowledged: true, mailMode: "confirm", origin: "http://127.0.0.1:3101",
    }),
  });
  if (!response.ok) throw new Error(`register-receiving failed: ${JSON.stringify(response.payload)}`);
  response = await api(kanaiPage, `/api/film-orders/${orderId}`, {
    method: "POST",
    data: JSON.stringify({
      action: "register-proof", aiFileName: "completion-proof.ai", aiFileUrl: "http://127.0.0.1:3101/completion-proof.ai",
      pdfFileName: "completion-proof.pdf", pdfFileUrl: "http://127.0.0.1:3101/completion-proof.pdf",
      mailMode: "confirm", origin: "http://127.0.0.1:3101",
    }),
  });
  expect(response.ok).toBeTruthy();
  response = await api(sevenPage, `/api/film-orders/${orderId}`, {
    method: "POST",
    data: JSON.stringify({ action: "send-customer-proof-review", mailMode: "confirm", origin: "http://127.0.0.1:3101" }),
  });
  expect(response.ok).toBeTruthy();

  // UI: Kanei records audited offline customer acceptance.
  await kanaiPage.goto("/data-intake");
  await kanaiPage.getByTestId("intake-search").fill(customer);
  await kanaiPage.getByTestId("intake-apply").click();
  const kaneiRow = kanaiPage.getByTestId("intake-row").filter({ hasText: customer }).first();
  await kaneiRow.waitFor({ timeout: 30_000 });
  await kaneiRow.getByTestId("intake-action-kanei_approval").click();
  await kanaiPage.getByLabel("承認者").fill("Completion Kanei");
  await kanaiPage.getByLabel("確認根拠（必須）").fill("completion UI evidence");
  await kanaiPage.getByLabel("確認理由（必須）").fill("completion UI customer approval record");
  const kaneiApprovalResponse = kanaiPage.waitForResponse(
    (response) => response.url().endsWith(`/api/film-orders/${orderId}`) && response.request().method() === "POST",
    { timeout: 60_000 },
  );
  await kanaiPage.getByTestId("intake-approval-submit").click();
  const kaneiApproval = await kaneiApprovalResponse;
  expect(kaneiApproval.ok()).toBeTruthy();
  await expect(kaneiRow).toContainText("承認済み", { timeout: 60_000 });

  // UI: Seven gives final approval.
  await sevenPage.goto("/data-intake");
  await sevenPage.getByTestId("intake-search").fill(customer);
  await sevenPage.getByTestId("intake-apply").click();
  const sevenRow = sevenPage.getByTestId("intake-row").filter({ hasText: customer }).first();
  await sevenRow.waitFor({ timeout: 30_000 });
  await sevenRow.getByTestId("intake-action-owner_approval").click();
  await sevenPage.getByLabel("最終承認データ名（任意）").fill("completion-final.pdf");
  const ownerApprovalResponse = sevenPage.waitForResponse(
    (response) => response.url().endsWith(`/api/film-orders/${orderId}`) && response.request().method() === "POST",
    { timeout: 60_000 },
  );
  await sevenPage.getByTestId("intake-approval-submit").click();
  const ownerApproval = await ownerApprovalResponse;
  expect(ownerApproval.ok()).toBeTruthy();
  await expect(sevenRow).toContainText("承認済み", { timeout: 60_000 });

  // API: register and confirm a delivery destination so PO becomes available.
  response = await api(sevenPage, `/api/film-orders/${orderId}`, {
    method: "POST",
    data: JSON.stringify({
      action: "register-ship-to",
      shipToCompanyName: "Completion Logistics", shipToPostalCode: "650-0001",
      shipToAddress: "Kobe Completion 1-1-1", shipToPhone: "078-000-0000",
      saveShipToMaster: false,
    }),
  });
  if (!response.ok) throw new Error(`register-ship-to failed: ${JSON.stringify(response.payload)}`);
  response = await api(sevenPage, `/api/film-orders/${orderId}`, { method: "POST", data: JSON.stringify({ action: "confirm-ship-to" }) });
  expect(response.ok).toBeTruthy();

  // UI: Kanei opens editable PO mail and sends it.
  await kanaiPage.goto("/data-intake");
  await kanaiPage.getByTestId("intake-search").fill(customer);
  await kanaiPage.getByTestId("intake-apply").click();
  const poRow = kanaiPage.getByTestId("intake-row").filter({ hasText: customer }).first();
  await poRow.waitFor({ timeout: 30_000 });
  const poButton = poRow.getByTestId("intake-action-purchase_order");
  await expect(poButton).toBeEnabled({ timeout: 30_000 });
  await poButton.click();
  await kanaiPage.getByTestId("intake-po-send").waitFor({ timeout: 30_000 });
  await kanaiPage.getByLabel("追加発注指示（任意）").fill("Completion UI: 500m units");
  const poSendResponse = kanaiPage.waitForResponse(
    (response) => response.url().endsWith(`/api/film-orders/${orderId}`) && response.request().method() === "POST",
    { timeout: 90_000 },
  );
  await kanaiPage.getByTestId("intake-po-send").click();
  const poSend = await poSendResponse;
  expect(poSend.ok()).toBeTruthy();
  await expect(poRow).toContainText("発注済み", { timeout: 60_000 });

  // UI: Kanei opens delivery-note draft, saves it, and downloads A4 PDF.
  const deliveryButton = poRow.getByTestId("intake-action-delivery_note");
  await expect(deliveryButton).toBeEnabled({ timeout: 30_000 });
  const deliveryDraftResponse = kanaiPage.waitForResponse(
    (response) => response.url().endsWith(`/api/film-orders/${orderId}/delivery-note-draft`) && response.request().method() === "GET",
    { timeout: 30_000 },
  );
  await deliveryButton.click();
  const deliveryDraft = await deliveryDraftResponse;
  expect(deliveryDraft.ok()).toBeTruthy();
  await kanaiPage.getByTestId("intake-delivery-note-title").waitFor({ timeout: 30_000 });
  await expect(kanaiPage.getByLabel("到着見込")).toBeVisible();
  await kanaiPage.getByRole("button", { name: "下書き保存" }).click();
  const pdfDownload = kanaiPage.waitForEvent("download", { timeout: 30_000 });
  await kanaiPage.getByRole("button", { name: "納品書PDF出力（A4）" }).click();
  const deliveryDownload = await pdfDownload;
  const deliveryPdf = readFileSync(await deliveryDownload.path());
  expect(deliveryPdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(deliveryPdf.length).toBeGreaterThan(1000);

  await kanaiContext.close();
  await sevenContext.close();
});

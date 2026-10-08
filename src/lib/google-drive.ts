import { createSign } from "node:crypto";

/**
 * Google Drive 直接アップロード（サービスアカウント）。
 * - ブラウザ → 自サーバーで発行した resumable session URL へ直接 PUT
 *   （Vercel の 4.5MB ボディ制限を回避し、大きな AI ファイルも扱える）
 * - 未設定の場合は URL 手入力フォールバックに戻る。
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function serviceAccount(): ServiceAccount | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (json) {
    try {
      const parsed = JSON.parse(json) as ServiceAccount;
      if (parsed.client_email && parsed.private_key) return parsed;
    } catch {
      // fallthrough
    }
  }
  const email = process.env.GOOGLE_SA_CLIENT_EMAIL?.trim();
  const key = process.env.GOOGLE_SA_PRIVATE_KEY?.trim();
  if (email && key) return { client_email: email, private_key: key.replace(/\\n/g, "\n") };
  return null;
}

export function driveConfigured(): boolean {
  return serviceAccount() != null || Boolean(oauthCredentials());
}

interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function oauthCredentials(): OAuthCredentials | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();
  if (clientId && clientSecret && refreshToken) return { clientId, clientSecret, refreshToken };
  return null;
}

export function receivingFolderId(): string {
  return process.env.FILM_RECEIVING_FOLDER_ID ?? "1u2iaE15tH5sQ6s39aGzaDet8tdAzgEf_";
}

export function proofFolderId(): string {
  return process.env.FILM_PROOF_FOLDER_ID ?? "1EP8faGx8z-tLUfdpStN74O9-oIuBSO0K";
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

async function getAccessToken(): Promise<string> {
  const oauth = oauthCredentials();
  if (oauth) {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: oauth.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) throw new Error(`drive_token_failed:${response.status}`);
    const payload = await response.json() as { access_token: string; expires_in: number };
    cachedToken = { token: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
    return cachedToken.token;
  }
  const account = serviceAccount();
  if (!account) throw new Error("drive_not_configured");
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(account.private_key).toString("base64url");
  const assertion = `${header}.${claims}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`drive_token_failed:${response.status}`);
  const payload = await response.json() as { access_token: string; expires_in: number };
  cachedToken = { token: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
  return cachedToken.token;
}

export async function createResumableSession(params: {
  fileName: string;
  folderId: string;
  contentType?: string;
  sizeBytes?: number;
}): Promise<string> {
  const token = await getAccessToken();
  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": params.contentType ?? "application/octet-stream",
        ...(params.sizeBytes != null ? { "X-Upload-Content-Length": String(params.sizeBytes) } : {}),
      },
      body: JSON.stringify({
        name: params.fileName,
        parents: [params.folderId],
      }),
    },
  );
  if (!response.ok) throw new Error(`drive_session_failed:${response.status}:${await response.text()}`);
  const sessionUri = response.headers.get("location") ?? response.headers.get("Location");
  if (!sessionUri) throw new Error("drive_session_missing");
  return sessionUri;
}

export async function findFileUrl(params: {
  fileName: string;
  folderId: string;
}): Promise<string | null> {
  const token = await getAccessToken();
  const query = encodeURIComponent(`name = '${params.fileName.replace(/'/g, "\\'")}' and '${params.folderId}' in parents and trashed = false`);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name)&q=${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`drive_find_failed:${response.status}`);
  const payload = await response.json() as { files?: Array<{ id: string }> };
  const fileId = payload.files?.[0]?.id;
  return fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
}

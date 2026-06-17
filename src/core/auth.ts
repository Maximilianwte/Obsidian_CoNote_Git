// Service-account OAuth2: sign a JWT with the key's RSA private key, exchange it
// for a short-lived access token. Uses Node's crypto (Obsidian runs in Electron;
// the MCP server runs in Node) — hence isDesktopOnly.

import * as crypto from "crypto";
import type { HttpFn } from "./fileStore";
import type { ServiceAccountKey } from "./types";

const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_TTL_SECONDS = 3600;
/** Refresh this many seconds before actual expiry. */
const REFRESH_SKEW_SECONDS = 300;

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Service account key is not valid JSON.");
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) {
    throw new Error(
      "Service account key is missing client_email or private_key."
    );
  }
  return {
    client_email: key.client_email,
    private_key: key.private_key,
    token_uri: key.token_uri || DEFAULT_TOKEN_URI,
  };
}

/** Mints and caches an access token for a single service-account key. */
export class TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly http: HttpFn
  ) {}

  async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && now < this.expiresAt - REFRESH_SKEW_SECONDS) {
      return this.token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: this.key.client_email,
        scope: SCOPE,
        aud: this.key.token_uri,
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
      })
    );
    const signingInput = `${header}.${claims}`;
    const signature = crypto
      .createSign("RSA-SHA256")
      .update(signingInput)
      .sign(this.key.private_key);
    const jwt = `${signingInput}.${base64url(signature)}`;

    const body =
      "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" +
      `&assertion=${encodeURIComponent(jwt)}`;

    const res = await this.http({
      url: this.key.token_uri || DEFAULT_TOKEN_URI,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `Token request failed (${res.status}): ${res.text || "no body"}`
      );
    }

    const data = JSON.parse(res.text) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error("Token response did not include an access_token.");
    }
    this.token = data.access_token;
    this.expiresAt =
      Math.floor(Date.now() / 1000) + (data.expires_in ?? TOKEN_TTL_SECONDS);
    return this.token;
  }

  /** Force a refresh on the next getToken (e.g. after a 401). */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }
}

// Firebase Auth via REST API — no Firebase SDK bundle needed.
// Handles: send magic link, complete sign-in (called from the hosting page callback),
// token refresh, and sign-out.

import type { HttpFn } from "./fileStore";
import { FIREBASE_CONFIG } from "./firebaseConfig";

const ID_TOOLKIT = `https://identitytoolkit.googleapis.com/v1`;
const SECURE_TOKEN = `https://securetoken.googleapis.com/v1`;
const KEY = () => FIREBASE_CONFIG.apiKey;

/** Refresh this many seconds before actual expiry. */
const REFRESH_SKEW_SECONDS = 300;

export interface FirebaseCredential {
  idToken: string;
  refreshToken: string;
  /** Unix seconds */
  expiresAt: number;
  uid: string;
  email: string;
}

/** Thin Firebase Auth client using the REST API. */
export class FirebaseAuthClient {
  private cred: FirebaseCredential | null = null;
  private inflightRefresh: Promise<string> | null = null;

  constructor(private readonly http: HttpFn) {}

  /** Load persisted credentials (call on plugin load). */
  load(cred: FirebaseCredential | null): void {
    this.cred = cred;
  }

  isSignedIn(): boolean {
    return !!this.cred;
  }

  getEmail(): string | null {
    return this.cred?.email ?? null;
  }

  getUid(): string | null {
    return this.cred?.uid ?? null;
  }

  getCredential(): FirebaseCredential | null {
    return this.cred;
  }

  /**
   * Get a valid (non-expired) ID token, refreshing automatically if needed.
   * Throws if not signed in.
   */
  async getIdToken(): Promise<string> {
    if (!this.cred) throw new Error("Not signed in.");
    const now = Math.floor(Date.now() / 1000);
    if (now < this.cred.expiresAt - REFRESH_SKEW_SECONDS) {
      return this.cred.idToken;
    }
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this.refreshToken().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  /**
   * Send a magic-link sign-in email.
   * `callbackUrl` should be the Firebase Hosting URL (hosting/index.html) with
   * the local callback port embedded, e.g.
   * `https://project.web.app/auth?port=4242&email=user@example.com`
   */
  async sendSignInLink(email: string, callbackUrl: string): Promise<void> {
    const res = await this.http({
      url: `${ID_TOOLKIT}/accounts:sendOobCode?key=${KEY()}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestType: "EMAIL_SIGNIN",
        email,
        continueUrl: callbackUrl,
        canHandleCodeInApp: true,
      }),
    });
    if (res.status < 200 || res.status >= 300) {
      const err = tryParseError(res.text);
      throw new Error(`Failed to send sign-in link: ${err}`);
    }
  }

  /**
   * Complete sign-in using the oobCode extracted from the magic link URL.
   * Called with the code the hosting page extracts from the link and passes
   * to the plugin via the local callback.
   */
  async signInWithEmailLink(email: string, oobCode: string): Promise<FirebaseCredential> {
    const res = await this.http({
      url: `${ID_TOOLKIT}/accounts:signInWithEmailLink?key=${KEY()}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, oobCode }),
    });
    if (res.status < 200 || res.status >= 300) {
      const err = tryParseError(res.text);
      throw new Error(`Sign-in failed: ${err}`);
    }
    const data = JSON.parse(res.text) as {
      idToken: string;
      refreshToken: string;
      expiresIn: string;
      localId: string;
      email: string;
    };
    this.cred = {
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + Number(data.expiresIn),
      uid: data.localId,
      email: data.email,
    };
    return this.cred;
  }

  signOut(): void {
    this.cred = null;
  }

  private async refreshToken(): Promise<string> {
    if (!this.cred) throw new Error("Not signed in.");
    const res = await this.http({
      url: `${SECURE_TOKEN}/token?key=${KEY()}`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(
        this.cred.refreshToken
      )}`,
    });
    if (res.status < 200 || res.status >= 300) {
      const err = tryParseError(res.text);
      throw new Error(`Token refresh failed: ${err}`);
    }
    const data = JSON.parse(res.text) as {
      id_token: string;
      refresh_token: string;
      expires_in: string;
      user_id: string;
    };
    this.cred = {
      ...this.cred,
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      expiresAt:
        Math.floor(Date.now() / 1000) + Number(data.expires_in),
    };
    return this.cred.idToken;
  }
}

function tryParseError(text: string): string {
  try {
    const d = JSON.parse(text) as { error?: { message?: string } };
    return d.error?.message ?? text;
  } catch {
    return text;
  }
}

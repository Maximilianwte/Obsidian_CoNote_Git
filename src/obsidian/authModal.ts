import { App, Modal, Notice } from "obsidian";
import * as http from "http";
import { FirebaseAuthClient, type FirebaseCredential } from "../core/firebaseAuth";
import { AUTH_REDIRECT_BASE } from "../core/firebaseConfig";

type AuthSuccess = (cred: FirebaseCredential) => void | Promise<void>;

/**
 * Sign-in modal: email input → send magic link → wait for browser callback →
 * complete sign-in → call onSuccess.
 *
 * Flow:
 *  1. User enters email, clicks "Send link".
 *  2. Plugin starts a local HTTP listener on a random port.
 *  3. Firebase sends a magic link pointing to the hosted /auth page with
 *     ?port=<port>&email=<email> in the continueUrl.
 *  4. User clicks the link in their email → browser opens the hosted page →
 *     page completes Firebase sign-in → browser hits localhost:<port>/callback.
 *  5. Plugin captures the tokens, calls onSuccess, closes the modal.
 */
export class AuthModal extends Modal {
  private server: http.Server | null = null;
  private port = 0;
  private waitingForCallback = false;
  private emailInput!: HTMLInputElement;
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    private readonly auth: FirebaseAuthClient,
    private readonly onSuccess: AuthSuccess
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Sign in to Conote" });
    contentEl.createEl("p", {
      text: "Enter your email. We'll send a one-click sign-in link — no password needed.",
      cls: "conote-auth-desc",
    });

    const form = contentEl.createDiv({ cls: "conote-auth-form" });
    this.emailInput = form.createEl("input", {
      type: "email",
      placeholder: "you@example.com",
      cls: "conote-auth-email",
    });
    this.emailInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.sendLink();
    });

    const btn = form.createEl("button", {
      text: "Send sign-in link",
      cls: "mod-cta",
    });
    btn.addEventListener("click", () => void this.sendLink());

    this.statusEl = contentEl.createEl("p", { cls: "conote-auth-status" });
  }

  onClose(): void {
    this.stopServer();
    this.contentEl.empty();
  }

  private async sendLink(): Promise<void> {
    const email = this.emailInput.value.trim();
    if (!email || !email.includes("@")) {
      this.setStatus("Please enter a valid email address.", "error");
      return;
    }
    this.setStatus("Starting local callback listener…");
    this.emailInput.disabled = true;

    try {
      this.port = await this.startCallbackServer(email);
      const continueUrl =
        `${AUTH_REDIRECT_BASE}?port=${this.port}&email=${encodeURIComponent(email)}`;
      await this.auth.sendSignInLink(email, continueUrl);
      this.waitingForCallback = true;
      this.setStatus(
        `Link sent to ${email}. Click it in your email — this modal will close automatically.`
      );
    } catch (err) {
      this.emailInput.disabled = false;
      this.stopServer();
      this.setStatus(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    }
  }

  private startCallbackServer(email: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (!req.url?.startsWith("/callback")) {
          res.end("ok");
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const idToken = url.searchParams.get("idToken");
        const refreshToken = url.searchParams.get("refreshToken");
        const uid = url.searchParams.get("uid");
        const returnedEmail = url.searchParams.get("email") ?? email;

        res.end(
          "<script>setTimeout(()=>window.close(),1000)</script>Signed in! You can close this tab."
        );
        server.close();
        this.server = null;

        if (!idToken || !refreshToken || !uid) {
          new Notice("Conote: sign-in callback missing tokens.", 6000);
          return;
        }
        const cred: FirebaseCredential = {
          idToken,
          refreshToken,
          // Firebase ID tokens are valid for 1 hour.
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          uid,
          email: returnedEmail,
        };
        this.auth.load(cred);
        const result = this.onSuccess(cred);
        if (result instanceof Promise) {
          void result.then(() => this.close());
        } else {
          this.close();
        }
      });

      server.once("error", reject);
      // Listen on a random available port.
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Could not start local callback server."));
          return;
        }
        this.server = server;
        resolve(addr.port);
      });
    });
  }

  private stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private setStatus(
    text: string,
    type: "normal" | "error" = "normal"
  ): void {
    this.statusEl.textContent = text;
    this.statusEl.className =
      type === "error" ? "conote-auth-status error" : "conote-auth-status";
  }
}

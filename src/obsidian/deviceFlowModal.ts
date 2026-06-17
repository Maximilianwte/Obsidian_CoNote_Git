import { App, Modal, Notice, requestUrl } from "obsidian";

interface ElectronShell { openExternal(url: string): Promise<void> }
interface Electron { shell: ElectronShell }
// electron is provided by Obsidian's Electron runtime — not bundled
const { shell } = (window.require as (m: "electron") => Electron)("electron");

const CLIENT_ID = "Ov23liMBmfkdhXSC9bEP";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const SCOPE = "repo";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
}

export class DeviceFlowModal extends Modal {
  private polling = false;
  private pollHandle: number | null = null;

  constructor(
    app: App,
    private readonly onSuccess: (token: string, username: string) => Promise<void>
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText("Sign in with GitHub");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "Requesting a sign-in code from GitHub…",
      cls: "conote-device-status",
    });

    let resp: DeviceCodeResponse;
    try {
      const res = await requestUrl({
        url: DEVICE_CODE_URL,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `client_id=${CLIENT_ID}&scope=${SCOPE}`,
      });
      resp = res.json as DeviceCodeResponse;
    } catch (e) {
      contentEl.empty();
      contentEl.createEl("p", {
        text: `Failed to reach GitHub: ${e instanceof Error ? e.message : String(e)}`,
        cls: "conote-device-error",
      });
      return;
    }

    this.renderCodeUI(resp);
    this.startPolling(resp);
  }

  private renderCodeUI(resp: DeviceCodeResponse): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("p", {
      text: "Enter this code on GitHub to authorize CoNote Git:",
      cls: "conote-device-status",
    });

    const codeEl = contentEl.createDiv({ cls: "conote-device-code" });
    codeEl.setText(resp.user_code);

    const btnRow = contentEl.createDiv({ cls: "conote-device-btn-row" });

    const copyBtn = btnRow.createEl("button", { text: "Copy code" });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(resp.user_code);
      new Notice("Code copied!");
    });

    const openBtn = btnRow.createEl("button", {
      text: "Open github.com/login/device",
      cls: "mod-cta",
    });
    openBtn.addEventListener("click", () => {
      void shell.openExternal(resp.verification_uri);
    });

    contentEl.createEl("p", {
      text: "Waiting for you to authorize in the browser…",
      cls: "conote-device-waiting",
    });

    // Auto-open the browser once
    void shell.openExternal(resp.verification_uri);
  }

  private startPolling(resp: DeviceCodeResponse): void {
    this.polling = true;
    const intervalMs = (resp.interval + 1) * 1000;
    const expiresAt = Date.now() + resp.expires_in * 1000;

    const poll = async (): Promise<void> => {
      if (!this.polling) return;
      if (Date.now() > expiresAt) {
        this.showError("Code expired. Close and try again.");
        return;
      }

      try {
        const res = await requestUrl({
          url: TOKEN_URL,
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `client_id=${CLIENT_ID}&device_code=${resp.device_code}&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code`,
        });
        const data = res.json as TokenResponse;

        if (data.access_token) {
          this.polling = false;
          const username = await this.fetchUsername(data.access_token);
          this.showSuccess(username);
          await this.onSuccess(data.access_token, username);
          return;
        }

        if (data.error === "expired_token") {
          this.showError("Code expired. Close and try again.");
          return;
        }
        // authorization_pending or slow_down — keep polling
      } catch {
        // transient network error — keep polling
      }

      if (this.polling) {
        this.pollHandle = window.setTimeout(() => void poll(), intervalMs);
      }
    };

    this.pollHandle = window.setTimeout(() => void poll(), intervalMs);
  }

  private async fetchUsername(token: string): Promise<string> {
    try {
      const res = await requestUrl({
        url: "https://api.github.com/user",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      return (res.json as { login: string }).login ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private showSuccess(username: string): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: `✓ Signed in as @${username}`,
      cls: "conote-device-success",
    });
    window.setTimeout(() => this.close(), 1500);
  }

  private showError(msg: string): void {
    this.polling = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: msg, cls: "conote-device-error" });
  }

  onClose(): void {
    this.polling = false;
    if (this.pollHandle !== null) {
      window.clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    this.contentEl.empty();
  }
}

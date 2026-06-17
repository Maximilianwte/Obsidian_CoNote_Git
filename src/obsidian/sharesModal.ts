import { App, Modal, Notice } from "obsidian";
import type { ApiClient } from "../core/apiClient";
import type { ShareInfo } from "../core/types";

type OnSharesChanged = (shares: ShareInfo[]) => void | Promise<void>;

/**
 * Shares modal: lists the user's shared folders, lets them create a new one,
 * generate an invite token (copy-paste to friend), or join via a token.
 */
export class SharesModal extends Modal {
  private shares: ShareInfo[] = [];
  private listEl!: HTMLElement;
  private loadingEl!: HTMLElement;

  constructor(
    app: App,
    private readonly api: ApiClient,
    private readonly onChange: OnSharesChanged
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Shared folders" });

    this.loadingEl = contentEl.createEl("p", { text: "Loading…", cls: "conote-shares-loading" });
    this.listEl = contentEl.createDiv({ cls: "conote-shares-list" });

    await this.refresh();

    // ── Create new share ──────────────────────────────────────────────────
    contentEl.createEl("hr");
    contentEl.createEl("h3", { text: "Create a new shared folder" });
    const createRow = contentEl.createDiv({ cls: "conote-shares-create" });
    const nameInput = createRow.createEl("input", {
      type: "text",
      placeholder: "Folder name (e.g. ProjectX)",
    });
    const createBtn = createRow.createEl("button", {
      text: "Create",
      cls: "mod-cta",
    });
    createBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      createBtn.disabled = true;
      createBtn.textContent = "Creating…";
      try {
        const share = await this.api.createShare(name);
        new Notice(`Conote: created shared folder "${share.name}"`);
        nameInput.value = "";
        await this.refresh();
        await this.onChange(this.shares);
      } catch (err) {
        new Notice(`Conote: ${err instanceof Error ? err.message : String(err)}`, 6000);
      } finally {
        createBtn.disabled = false;
        createBtn.textContent = "Create";
      }
    });

    // ── Join via invite token ─────────────────────────────────────────────
    contentEl.createEl("h3", { text: "Join a shared folder" });
    const joinRow = contentEl.createDiv({ cls: "conote-shares-create" });
    const tokenInput = joinRow.createEl("input", {
      type: "text",
      placeholder: "Paste invite token here",
    });
    const joinBtn = joinRow.createEl("button", { text: "Join" });
    joinBtn.addEventListener("click", async () => {
      const token = tokenInput.value.trim();
      if (!token) return;
      joinBtn.disabled = true;
      joinBtn.textContent = "Joining…";
      try {
        const share = await this.api.joinShare(token);
        new Notice(`Conote: joined "${share.name}"`);
        tokenInput.value = "";
        await this.refresh();
        await this.onChange(this.shares);
      } catch (err) {
        new Notice(`Conote: ${err instanceof Error ? err.message : String(err)}`, 6000);
      } finally {
        joinBtn.disabled = false;
        joinBtn.textContent = "Join";
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async refresh(): Promise<void> {
    this.loadingEl.style.display = "block";
    this.listEl.empty();
    try {
      this.shares = await this.api.listShares();
      this.loadingEl.style.display = "none";
      this.renderList();
    } catch (err) {
      this.loadingEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private renderList(): void {
    if (this.shares.length === 0) {
      this.listEl.createEl("p", {
        text: "No shared folders yet. Create one below.",
        cls: "conote-shares-empty",
      });
      return;
    }
    for (const share of this.shares) {
      this.renderShareRow(share);
    }
  }

  private renderShareRow(share: ShareInfo): void {
    const row = this.listEl.createDiv({ cls: "conote-share-row" });
    const info = row.createDiv({ cls: "conote-share-info" });
    info.createEl("strong", { text: share.name });
    info.createEl("span", {
      text: ` (${share.role})  •  prefix: ${share.gcsPrefix}`,
      cls: "conote-share-meta",
    });

    const actions = row.createDiv({ cls: "conote-share-actions" });

    if (share.role === "owner") {
      const inviteBtn = actions.createEl("button", { text: "Get invite token" });
      inviteBtn.addEventListener("click", async () => {
        inviteBtn.disabled = true;
        inviteBtn.textContent = "Generating…";
        try {
          const token = await this.api.createInvite(share.shareId);
          await navigator.clipboard.writeText(token);
          new Notice(
            `Invite token copied to clipboard!\n\nSend this to your collaborator — they paste it in "Join a shared folder".`,
            8000
          );
        } catch (err) {
          new Notice(`Conote: ${err instanceof Error ? err.message : String(err)}`, 6000);
        } finally {
          inviteBtn.disabled = false;
          inviteBtn.textContent = "Get invite token";
        }
      });
    }

    const leaveLabel = share.role === "owner" ? "Delete share" : "Leave";
    const leaveBtn = actions.createEl("button", { text: leaveLabel });
    leaveBtn.addEventListener("click", async () => {
      const confirm = window.confirm(
        share.role === "owner"
          ? `Delete the shared folder "${share.name}"? The GCS prefix and its files remain in the bucket but will no longer be shared.`
          : `Leave the shared folder "${share.name}"?`
      );
      if (!confirm) return;
      leaveBtn.disabled = true;
      try {
        await this.api.leaveShare(share.shareId);
        await this.refresh();
        await this.onChange(this.shares);
      } catch (err) {
        new Notice(`Conote: ${err instanceof Error ? err.message : String(err)}`, 6000);
        leaveBtn.disabled = false;
      }
    });
  }
}

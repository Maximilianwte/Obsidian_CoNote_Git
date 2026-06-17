import { App, PluginSettingTab, Setting, Notice, normalizePath } from "obsidian";
import type ConotePlugin from "./main";
import type { FirebaseCredential } from "../core/firebaseAuth";
import type { FolderMappingV2 } from "../core/types";

export interface ConoteSettings {
  // ── Auth (stored in plugin data, never shown as raw text) ────────────────
  credential: FirebaseCredential | null;

  // ── Folder mappings ───────────────────────────────────────────────────────
  mappings: FolderMappingV2[];

  // ── Sync ─────────────────────────────────────────────────────────────────
  author: string;
  pollIntervalSeconds: number;
  autoSync: boolean;
}

export const DEFAULT_SETTINGS: ConoteSettings = {
  credential: null,
  mappings: [],
  author: "",
  pollIntervalSeconds: 15,
  autoSync: true,
};

export class ConoteSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ConotePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Auth section ─────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Account" });

    const cred = this.plugin.settings.credential;
    if (cred) {
      new Setting(containerEl)
        .setName("Signed in")
        .setDesc(`As ${cred.email}`)
        .addButton((b) =>
          b.setButtonText("Sign out").onClick(async () => {
            this.plugin.signOut();
            await this.plugin.saveSettings();
            this.display();
            new Notice("Conote: signed out.");
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Sign in")
        .setDesc(
          "Sign in with your email — a one-click magic link will be sent. No password needed."
        )
        .addButton((b) =>
          b
            .setButtonText("Sign in with email")
            .setCta()
            .onClick(() => this.plugin.openAuthModal())
        );
    }

    // ── Display name ─────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Your display name")
      .setDesc("Shown as the author on changes you push.")
      .addText((t) =>
        t
          .setPlaceholder("Max")
          .setValue(this.plugin.settings.author)
          .onChange(async (v) => {
            this.plugin.settings.author = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Sync ──────────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Sync" });

    new Setting(containerEl)
      .setName("Automatic sync")
      .setDesc("Push on save and poll the bucket on an interval.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSync).onChange(async (v) => {
          this.plugin.settings.autoSync = v;
          await this.plugin.saveSettings();
          this.plugin.restartSync();
        })
      );

    new Setting(containerEl)
      .setName("Poll interval (seconds)")
      .setDesc("How often to check for remote changes. Minimum 5.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.pollIntervalSeconds))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 5) {
              this.plugin.settings.pollIntervalSeconds = Math.floor(n);
              await this.plugin.saveSettings();
              this.plugin.restartSync();
            }
          })
      );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Sync now").onClick(() => void this.plugin.syncNow())
    );

    // ── Shared folders ───────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Shared folders" });
    containerEl.createEl("p", {
      text: 'Map a local vault folder to a GCS prefix. Use "Manage shares" to create or join shared folders.',
      cls: "setting-item-description",
    });

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Manage shares…")
        .onClick(() => this.plugin.openSharesModal())
    );

    this.plugin.settings.mappings.forEach((mapping, i) => {
      const row = containerEl.createDiv({ cls: "conote-mapping-row" });

      const local = row.createEl("input", {
        type: "text",
        placeholder: "Vault folder (e.g. Shared/ProjectX)",
      });
      local.value = mapping.localFolder;
      local.title = "Local vault folder";
      local.addEventListener("change", async () => {
        mapping.localFolder = normalizePath(local.value.trim());
        await this.plugin.saveSettings();
      });

      const prefix = row.createEl("input", {
        type: "text",
        placeholder: "GCS prefix (e.g. users/uid/ProjectX)",
      });
      prefix.value = mapping.gcsPrefix;
      prefix.title = "GCS object prefix";
      prefix.addEventListener("change", async () => {
        mapping.gcsPrefix = prefix.value.trim().replace(/^\/+|\/+$/g, "");
        await this.plugin.saveSettings();
      });

      if (mapping.shareId) {
        row.createEl("span", {
          text: `shared`,
          cls: "conote-share-badge",
        });
      }

      const remove = row.createEl("button", { text: "×" });
      remove.title = "Remove this mapping";
      remove.addEventListener("click", async () => {
        this.plugin.settings.mappings.splice(i, 1);
        await this.plugin.saveSettings();
        this.display();
      });
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add folder mapping").onClick(async () => {
        const uid = this.plugin.getUid() ?? "uid";
        this.plugin.settings.mappings.push({
          localFolder: "",
          gcsPrefix: `users/${uid}/`,
          name: "",
        });
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
}

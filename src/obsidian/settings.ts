import { App, PluginSettingTab, Setting, Notice, normalizePath } from "obsidian";
import type ConotePlugin from "./main";
import type { GitFolderMapping } from "../core/types";
import { FolderPickerModal } from "./folderPickerModal";
import { RepoPickerModal } from "./repoPickerModal";
import { DeviceFlowModal } from "./deviceFlowModal";

export interface ConoteSettings {
  /** GitHub OAuth token (device flow). Stored in plugin data. */
  pat: string;
  /** GitHub username, resolved after sign-in. */
  githubUsername: string;
  /** Display name used in git commit author field. */
  author: string;
  /** Folder→repo mappings. */
  mappings: GitFolderMapping[];
  /** Auto-push inactivity window in seconds. */
  pushDebounceSeconds: number;
  /** Pull interval in seconds. */
  pullIntervalSeconds: number;
  /** Whether automatic sync is enabled. */
  autoSync: boolean;
}

export const DEFAULT_SETTINGS: ConoteSettings = {
  pat: "",
  githubUsername: "",
  author: "",
  mappings: [],
  pushDebounceSeconds: 10,
  pullIntervalSeconds: 30,
  autoSync: true,
};

export class ConoteSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ConotePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── GitHub auth ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName("GitHub").setHeading();

    const { pat, githubUsername } = this.plugin.settings;
    if (pat && githubUsername) {
      new Setting(containerEl)
        .setName(`Connected as @${githubUsername}`)
        .setDesc("Your token is stored locally and never uploaded.")
        .addButton((b) =>
          b.setButtonText("Sign out").onClick(async () => {
            this.plugin.settings.pat = "";
            this.plugin.settings.githubUsername = "";
            await this.plugin.saveSettings();
            this.display();
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Sign in with GitHub")
        .setDesc(
          "Opens github.com in your browser. You'll enter a short code to authorize CoNote Git. No password is shared with the plugin."
        )
        .addButton((b) =>
          b
            .setButtonText("Sign in with GitHub")
            .setCta()
            .onClick(() => {
              new DeviceFlowModal(
                this.app,
                async (token, username) => {
                  this.plugin.settings.pat = token;
                  this.plugin.settings.githubUsername = username;
                  if (!this.plugin.settings.author) {
                    this.plugin.settings.author = username;
                  }
                  await this.plugin.saveSettings();
                  this.display();
                }
              ).open();
            })
        );
    }

    new Setting(containerEl)
      .setName("Display name")
      .setDesc("Used as the git commit author name.")
      .addText((t) =>
        t
          .setPlaceholder("Max Mustermann")
          .setValue(this.plugin.settings.author)
          .onChange(async (v) => {
            this.plugin.settings.author = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Sync settings ─────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Automatic sync")
      .setDesc("Auto-push after inactivity, auto-pull on interval.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSync).onChange(async (v) => {
          this.plugin.settings.autoSync = v;
          await this.plugin.saveSettings();
          this.plugin.restartSync();
        })
      );

    new Setting(containerEl)
      .setName("Push after inactivity (seconds)")
      .setDesc("Commit and push this many seconds after the last edit in a synced folder.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.pushDebounceSeconds))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 3) {
              this.plugin.settings.pushDebounceSeconds = Math.floor(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Pull interval (seconds)")
      .setDesc("How often to fetch and merge from GitHub.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.pullIntervalSeconds))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 10) {
              this.plugin.settings.pullIntervalSeconds = Math.floor(n);
              await this.plugin.saveSettings();
              this.plugin.restartSync();
            }
          })
      );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Sync now").onClick(() => void this.plugin.syncNow())
    );

    // ── Folder mappings ───────────────────────────────────────────────────────
    new Setting(containerEl).setName("Shared folders").setHeading();
    containerEl.createEl("p", {
      text: "Each row maps a vault subfolder to a GitHub repository. The repo is cloned into the plugin's data directory so your vault stays clean.",
      cls: "setting-item-description",
    });

    this.plugin.settings.mappings.forEach((mapping, i) => {
      const wrap = containerEl.createDiv({ cls: "conote-mapping-block" });

      const row1 = wrap.createDiv({ cls: "conote-mapping-row" });

      const labelInput = row1.createEl("input", {
        type: "text",
        placeholder: "Label (e.g. ProjectX)",
      });
      labelInput.value = mapping.label;
      labelInput.title = "Human-readable name";
      labelInput.addEventListener("change", () => {
        void (async () => {
          mapping.label = labelInput.value.trim();
          await this.plugin.saveSettings();
        })();
      });

      const localInput = row1.createEl("input", {
        type: "text",
        placeholder: "Vault folder — click to browse",
        cls: "conote-picker-trigger",
      });
      localInput.value = mapping.localFolder;
      localInput.title = "Click to browse vault folders";
      localInput.readOnly = true;
      localInput.addEventListener("click", () => {
        new FolderPickerModal(this.app, (path) => {
          mapping.localFolder = normalizePath(path);
          localInput.value = mapping.localFolder;
          void this.plugin.saveSettings();
        }).open();
      });

      const row2 = wrap.createDiv({ cls: "conote-mapping-row" });

      const repoInput = row2.createEl("input", {
        type: "text",
        placeholder: "GitHub repo — click to browse",
        cls: "conote-picker-trigger",
      });
      repoInput.value = mapping.repoUrl;
      repoInput.title = "Click to browse GitHub repositories";
      repoInput.readOnly = true;
      repoInput.addEventListener("click", () => {
        if (!this.plugin.settings.pat) {
          new Notice("CoNote Git: add your GitHub PAT first.");
          return;
        }
        new RepoPickerModal(this.app, this.plugin.settings.pat, (url) => {
          mapping.repoUrl = url;
          repoInput.value = url;
          void this.plugin.saveSettings();
        }).open();
      });

      const branchInput = row2.createEl("input", {
        type: "text",
        placeholder: "main",
      });
      branchInput.value = mapping.branch;
      branchInput.addClass("conote-branch-input");
      branchInput.title = "Branch";
      branchInput.addEventListener("change", () => {
        mapping.branch = branchInput.value.trim() || "main";
        void this.plugin.saveSettings();
      });

      const cloneBtn = row2.createEl("button", { text: "Clone / init" });
      cloneBtn.title = "Clone the repo (or re-verify if already cloned)";
      cloneBtn.addEventListener("click", () => void (async () => {
        if (!this.plugin.settings.pat) {
          new Notice("Conote: add your GitHub PAT first.");
          return;
        }
        cloneBtn.disabled = true;
        cloneBtn.textContent = "Cloning…";
        try {
          await this.plugin.initMapping(mapping);
          new Notice(`Conote: "${mapping.label || mapping.repoUrl}" ready.`);
        } catch (err) {
          new Notice(
            `Conote: clone failed — ${err instanceof Error ? err.message : String(err)}`,
            8000
          );
        } finally {
          cloneBtn.disabled = false;
          cloneBtn.textContent = "Clone / init";
        }
      })());

      const removeBtn = row2.createEl("button", { text: "Remove" });
      removeBtn.addEventListener("click", () => {
        this.plugin.settings.mappings.splice(i, 1);
        void this.plugin.saveSettings().then(() => this.display());
      });
    });

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Add folder mapping")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.mappings.push({
            id: crypto.randomUUID(),
            localFolder: "",
            repoUrl: "",
            branch: "main",
            label: "",
          });
          await this.plugin.saveSettings();
          this.display();
        })
    );
  }
}

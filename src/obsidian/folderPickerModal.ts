import { App, Modal } from "obsidian";

export class FolderPickerModal extends Modal {
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private folders: string[];

  constructor(app: App, private readonly onSelect: (path: string) => void) {
    super(app);
    this.folders = app.vault
      .getAllFolders(true)
      .map((f) => f.path)
      .filter((p) => p !== "" && p !== "/")
      .sort();
  }

  onOpen(): void {
    this.titleEl.setText("Select vault folder");
    const { contentEl } = this;
    contentEl.empty();

    this.searchEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "Search folders…",
      cls: "conote-picker-search",
    });
    this.searchEl.addEventListener("input", () => this.renderList());

    this.listEl = contentEl.createDiv({ cls: "conote-picker-list" });
    this.renderList();

    const newSection = contentEl.createDiv({ cls: "conote-picker-new" });
    newSection.createEl("p", {
      text: "Or create a new folder:",
      cls: "conote-picker-new-label",
    });
    const newRow = newSection.createDiv({ cls: "conote-picker-new-row" });
    const newInput = newRow.createEl("input", {
      type: "text",
      placeholder: "e.g. Shared/ProjectX",
      cls: "conote-picker-new-input",
    });
    const createBtn = newRow.createEl("button", {
      text: "Create & select",
      cls: "mod-cta",
    });
    createBtn.addEventListener("click", async () => {
      const path = newInput.value.trim();
      if (!path) return;
      try {
        await this.app.vault.createFolder(path);
      } catch {
        // folder may already exist — that's fine
      }
      this.onSelect(path);
      this.close();
    });
    newInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") createBtn.click();
    });

    this.searchEl.focus();
  }

  private renderList(): void {
    this.listEl.empty();
    const q = this.searchEl.value.toLowerCase();
    const hits = q
      ? this.folders.filter((p) => p.toLowerCase().includes(q))
      : this.folders;

    if (hits.length === 0) {
      this.listEl.createEl("div", {
        text: q ? "No matching folders." : "No subfolders in vault yet — create one below.",
        cls: "conote-picker-empty",
      });
      return;
    }

    for (const path of hits) {
      const item = this.listEl.createDiv({ cls: "conote-picker-item" });
      const depth = path.split("/").length - 1;
      item.style.paddingLeft = `${12 + depth * 14}px`;
      item.createSpan({ text: path });
      item.addEventListener("click", () => {
        this.onSelect(path);
        this.close();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

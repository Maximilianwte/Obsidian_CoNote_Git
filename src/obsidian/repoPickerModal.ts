import { App, Modal, requestUrl } from "obsidian";

interface GithubRepo {
  full_name: string;
  html_url: string;
  private: boolean;
  description: string | null;
}

export class RepoPickerModal extends Modal {
  private repos: GithubRepo[] = [];
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private loaded = false;

  constructor(
    app: App,
    private readonly pat: string,
    private readonly onSelect: (url: string) => void
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText("Select GitHub repository");
    const { contentEl } = this;
    contentEl.empty();

    this.searchEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "Search repos…",
      cls: "conote-picker-search",
    });
    this.searchEl.disabled = true;
    this.searchEl.addEventListener("input", () => this.renderList());

    this.listEl = contentEl.createDiv({ cls: "conote-picker-list" });
    this.listEl.createEl("div", {
      text: "Loading repositories…",
      cls: "conote-picker-loading",
    });

    try {
      // Fetch up to 300 repos across 3 pages
      for (let page = 1; page <= 3; page++) {
        const res = await requestUrl({
          url: `https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`,
          headers: {
            Authorization: `token ${this.pat}`,
            Accept: "application/vnd.github.v3+json",
          },
        });
        const batch: GithubRepo[] = res.json;
        this.repos.push(...batch);
        if (batch.length < 100) break;
      }
      this.loaded = true;
      this.searchEl.disabled = false;
      this.searchEl.focus();
      this.renderList();
    } catch (e) {
      this.listEl.empty();
      this.listEl.createEl("div", {
        text: `Failed to load repos: ${e instanceof Error ? e.message : String(e)}`,
        cls: "conote-picker-error",
      });
      this.renderCustomUrlRow(contentEl);
    }
  }

  private renderList(): void {
    if (!this.loaded) return;
    this.listEl.empty();
    const q = this.searchEl.value.toLowerCase();
    const hits = q
      ? this.repos.filter(
          (r) =>
            r.full_name.toLowerCase().includes(q) ||
            (r.description?.toLowerCase().includes(q) ?? false)
        )
      : this.repos;

    if (hits.length === 0) {
      this.listEl.createEl("div", {
        text: "No repos match.",
        cls: "conote-picker-empty",
      });
      return;
    }

    for (const repo of hits) {
      const item = this.listEl.createDiv({ cls: "conote-picker-item" });
      const header = item.createDiv({ cls: "conote-picker-repo-header" });
      header.createSpan({ text: repo.full_name, cls: "conote-picker-repo-name" });
      header.createSpan({
        text: repo.private ? "private" : "public",
        cls: `conote-picker-badge ${repo.private ? "conote-badge-private" : "conote-badge-public"}`,
      });
      if (repo.description) {
        item.createDiv({ text: repo.description, cls: "conote-picker-repo-desc" });
      }
      item.addEventListener("click", () => {
        this.onSelect(repo.html_url);
        this.close();
      });
    }
  }

  private renderCustomUrlRow(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "conote-picker-new" });
    row.createEl("p", {
      text: "Or paste a repo URL directly:",
      cls: "conote-picker-new-label",
    });
    const inner = row.createDiv({ cls: "conote-picker-new-row" });
    const urlInput = inner.createEl("input", {
      type: "text",
      placeholder: "https://github.com/user/repo",
      cls: "conote-picker-new-input",
    });
    const useBtn = inner.createEl("button", { text: "Use URL", cls: "mod-cta" });
    useBtn.addEventListener("click", () => {
      const url = urlInput.value.trim();
      if (url) { this.onSelect(url); this.close(); }
    });
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") useBtn.click();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

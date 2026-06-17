import { App, Modal, Notice } from "obsidian";
import { diffLines } from "diff";
import type { Conflict } from "../core/types";

type ResolveFn = (merged: string) => void | Promise<void>;

/**
 * GitHub-style conflict resolver: shows the local and remote versions side by
 * side with line-level diff highlighting, plus an editable result pane the user
 * assembles and saves. Text-only (binary conflicts never reach this modal).
 */
export class MergeModal extends Modal {
  private readonly localText: string;
  private readonly remoteText: string;
  private resultEl!: HTMLTextAreaElement;
  private settled = false;

  constructor(
    app: App,
    private readonly conflict: Conflict,
    private readonly onResolve: ResolveFn,
    private readonly onCancel?: () => void
  ) {
    super(app);
    const dec = new TextDecoder();
    this.localText = dec.decode(conflict.localContent);
    this.remoteText = dec.decode(conflict.remoteContent);
  }

  /** Promise-based variant for the re-resolution loop. Resolves to null on cancel. */
  static openAsync(app: App, conflict: Conflict): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new MergeModal(
        app,
        conflict,
        (merged) => resolve(merged),
        () => resolve(null)
      );
      modal.open();
    });
  }

  onOpen(): void {
    this.modalEl.addClass("conote-merge-modal");
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Resolve conflict" });
    const author = this.conflict.remoteAuthor || "someone else";
    contentEl.createEl("p", {
      cls: "conote-merge-header",
      text: `${this.conflict.localPath} — you and ${author} both edited this. Assemble the final version below, then Save.`,
    });

    const panes = contentEl.createDiv({ cls: "conote-merge-panes" });
    this.renderPane(panes, "Yours (local)", "local");
    this.renderPane(panes, `Theirs (${author})`, "remote");

    contentEl.createEl("div", {
      cls: "conote-merge-result-title",
      text: "Merged result (editable)",
    });
    this.resultEl = contentEl.createEl("textarea", {
      cls: "conote-merge-result",
    });
    this.resultEl.value = this.localText;

    const buttons = contentEl.createDiv({ cls: "conote-merge-buttons" });
    this.makeButton(buttons, "Use mine", () => {
      this.resultEl.value = this.localText;
    });
    this.makeButton(buttons, "Use theirs", () => {
      this.resultEl.value = this.remoteText;
    });
    this.makeButton(buttons, "Append theirs below mine", () => {
      this.resultEl.value =
        this.localText.replace(/\s*$/, "") +
        "\n\n<<<<<<< theirs >>>>>>>\n\n" +
        this.remoteText;
    });
    const save = this.makeButton(buttons, "Save & upload", () => this.save());
    save.addClass("mod-cta");
    this.makeButton(buttons, "Cancel", () => this.close());
  }

  private renderPane(
    parent: HTMLElement,
    title: string,
    side: "local" | "remote"
  ): void {
    const pane = parent.createDiv({ cls: "conote-merge-pane" });
    const head = pane.createDiv({ cls: "conote-merge-pane-title" });
    head.createSpan({ text: title });
    const copyBtn = head.createEl("button", { text: "Copy" });
    copyBtn.addEventListener("click", () => {
      const txt = side === "local" ? this.localText : this.remoteText;
      void navigator.clipboard.writeText(txt);
      new Notice("Copied to clipboard");
    });

    const pre = pane.createEl("pre", { cls: "conote-merge-diff" });
    // diffLines(remote, local): "added" = present in local only, "removed" = remote only.
    const parts = diffLines(this.remoteText, this.localText);
    for (const part of parts) {
      let cls = "conote-diff-line";
      if (part.added) {
        if (side === "remote") continue; // not in remote
        cls += " conote-diff-added";
      } else if (part.removed) {
        if (side === "local") continue; // not in local
        cls += " conote-diff-removed";
      }
      const span = pre.createEl("span", { cls });
      span.setText(part.value);
    }
  }

  private makeButton(
    parent: HTMLElement,
    label: string,
    onClick: () => void
  ): HTMLButtonElement {
    const btn = parent.createEl("button", { text: label });
    btn.addEventListener("click", onClick);
    return btn;
  }

  private async save(): Promise<void> {
    this.settled = true;
    const merged = this.resultEl.value;
    this.close();
    await this.onResolve(merged);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.onCancel?.();
  }
}

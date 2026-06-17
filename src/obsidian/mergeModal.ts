import { App, Modal, Notice } from "obsidian";
import { diffLines } from "diff";
import type { Conflict } from "../core/types";

type ResolveFn = (merged: string) => void | Promise<void>;

/**
 * Side-by-side conflict resolver. Shows local vs remote diffs and an editable
 * merged result. Used for both manual invocation and the sync engine conflict flow.
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

  /** Promise-based helper for programmatic use. Resolves to null on cancel. */
  static openAsync(app: App, conflict: Conflict): Promise<string | null> {
    return new Promise((resolve) => {
      new MergeModal(
        app,
        conflict,
        (merged) => resolve(merged),
        () => resolve(null)
      ).open();
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
      text: `${this.conflict.localPath} — you and ${author} both edited this file. Assemble the final version below, then save.`,
    });

    const panes = contentEl.createDiv({ cls: "conote-merge-panes" });
    this.renderPane(panes, "Yours (local)", "local");
    this.renderPane(panes, `Theirs (${author})`, "remote");

    contentEl.createEl("div", {
      cls: "conote-merge-result-title",
      text: "Merged result (editable)",
    });
    this.resultEl = contentEl.createEl("textarea", { cls: "conote-merge-result" });
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
        this.localText.replace(/\s*$/, "") + "\n\n" + this.remoteText;
    });
    const save = this.makeButton(buttons, "Save & push", () => void this.save());
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
      void navigator.clipboard.writeText(
        side === "local" ? this.localText : this.remoteText
      );
      new Notice("Copied to clipboard");
    });

    const pre = pane.createEl("pre", { cls: "conote-merge-diff" });
    // diffLines(base, compare): added = present only in compare
    const parts = diffLines(this.remoteText, this.localText);
    for (const part of parts) {
      if (part.added && side === "remote") continue;
      if (part.removed && side === "local") continue;
      let cls = "conote-diff-line";
      if (part.added) cls += " conote-diff-added";
      else if (part.removed) cls += " conote-diff-removed";
      pre.createEl("span", { cls }).setText(part.value);
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
    const result = this.onResolve(merged);
    if (result instanceof Promise) await result;
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.onCancel?.();
  }
}

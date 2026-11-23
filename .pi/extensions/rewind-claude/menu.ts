import { basename } from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { RestoreChange } from "./core.ts";
import { MenuModel } from "./menu-model.ts";

const CLAUDE_ACCENT = [87, 105, 247] as const;
const SELECTED_COLOR = CLAUDE_ACCENT;
const CLAUDE_MUTED = 246;
const CLAUDE_ADDED = 72;
const CLAUDE_REMOVED = 174;

type TerminalColor = number | readonly [number, number, number];

function foregroundCode(color: TerminalColor): string {
    return typeof color === "number"
        ? `\u001b[38;5;${color}m`
        : `\u001b[38;2;${color.join(";")}m`;
}

function foreground(color: TerminalColor, text: string): string {
    return `${foregroundCode(color)}${text}\u001b[39m`;
}

function styled(style: 1 | 3, color: TerminalColor | undefined, text: string): string {
    const colorCode = color === undefined ? "" : foregroundCode(color);
    // Claude Code 对强调文本使用 reset-all；不能拆成 reset-color/reset-style，避免强度状态泄漏。
    return `\u001b[${style}m${colorCode}${text}\u001b[0m`;
}

function dim(text: string): string {
    return `\u001b[2m${text}\u001b[22m`;
}

export interface RewindMenuItem<T> {
    value: T;
    label: string;
    description?: string;
    acceptsContext?: boolean;
}

export interface RewindPointItem<T> extends RewindMenuItem<T> {
    changes: RestoreChange[] | undefined;
}

export interface RewindMenuResult<T> {
    value: T;
    context: string;
}

interface MenuOptions<T, Item extends RewindMenuItem<T>> {
    items: Item[];
    initialValue?: T;
    theme: Theme;
    onDone: (result: RewindMenuResult<T> | null) => void;
    requestRender: () => void;
}

function line(text: string, width: number): string {
    return truncateToWidth(text, width, "…");
}

function divider(width: number): string {
    return foreground(CLAUDE_ACCENT, "─".repeat(Math.max(0, width)));
}

function turnChangeLine(changes: RestoreChange[] | undefined): string {
    if (changes === undefined) return foreground(CLAUDE_MUTED, "⚠ No code restore");
    if (changes.length === 0) return foreground(CLAUDE_MUTED, "No code changes");
    const additions = changes.reduce((sum, change) => sum + change.additions, 0);
    const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
    const label = changes.length === 1
        ? `${basename(changes[0]!.path)} `
        : `${changes.length} files changed `;
    return (
        foreground(CLAUDE_MUTED, label) +
        foreground(CLAUDE_ADDED, `+${additions}`) +
        foreground(CLAUDE_MUTED, " ") +
        foreground(CLAUDE_REMOVED, `-${deletions}`)
    );
}

/** Claude Code Rewind 第一屏：checkpoint 时间正序，末尾 current 是独立选项。 */
export class RewindPointMenu<T> implements Component {
    private readonly items: Array<RewindPointItem<T>>;
    private readonly onDone: (result: RewindMenuResult<T> | null) => void;
    private readonly requestRender: () => void;
    private selectedIndex: number;

    constructor(options: MenuOptions<T, RewindPointItem<T>>) {
        this.items = options.items;
        this.onDone = options.onDone;
        this.requestRender = options.requestRender;
        const initialIndex = this.items.findIndex((item) => Object.is(item.value, options.initialValue));
        this.selectedIndex = initialIndex >= 0 ? initialIndex : this.items.length;
    }

    render(width: number): string[] {
        const lines = [
            divider(width),
            line(`  ${styled(1, CLAUDE_ACCENT, "Rewind")}`, width),
            "",
            line("  Restore the code and/or conversation to the point before…", width),
            "",
        ];
        const optionCount = this.items.length + 1;
        const maxVisible = 7;
        const firstVisible = Math.max(
            0,
            Math.min(
                this.selectedIndex - Math.floor(maxVisible / 2),
                optionCount - maxVisible,
            ),
        );
        const lastVisible = Math.min(optionCount, firstVisible + maxVisible);
        for (let index = firstVisible; index < lastVisible; index++) {
            if (index === this.items.length) {
                const current = this.selectedIndex === index
                    ? `  ${styled(1, SELECTED_COLOR, "❯")} ${styled(3, SELECTED_COLOR, "(current)")}`
                    : `    ${styled(3, undefined, "(current)")}`;
                lines.push(line(current, width), "");
                continue;
            }
            const item = this.items[index]!;
            const selected = index === this.selectedIndex;
            const prompt = selected
                ? `  ${styled(1, SELECTED_COLOR, "❯ ")}${foreground(SELECTED_COLOR, item.label)}`
                : `    ${item.label}`;
            lines.push(line(prompt, width));
            lines.push(line(`    ${turnChangeLine(item.changes)}`, width));
            lines.push("");
        }

        lines.push("", line(`  ${styled(3, CLAUDE_MUTED, "Enter to continue · Esc to cancel")}`, width));
        return lines;
    }

    handleInput(data: string): void {
        const count = this.items.length + 1;
        if (matchesKey(data, Key.up)) {
            this.selectedIndex = (this.selectedIndex - 1 + count) % count;
        } else if (matchesKey(data, Key.down)) {
            this.selectedIndex = (this.selectedIndex + 1) % count;
        } else if (matchesKey(data, Key.enter)) {
            if (this.selectedIndex === this.items.length) this.onDone(null);
            else this.onDone({ value: this.items[this.selectedIndex]!.value, context: "" });
            return;
        } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            this.onDone(null);
            return;
        } else if (/^[1-9]$/.test(data)) {
            const index = Number(data) - 1;
            if (index < this.items.length) {
                this.onDone({ value: this.items[index]!.value, context: "" });
                return;
            }
        } else {
            return;
        }
        this.requestRender();
    }

    invalidate(): void {}
}

abstract class InteractiveMenu<T, Item extends RewindMenuItem<T>> implements Component {
    protected readonly model: MenuModel<T>;
    protected readonly items: Item[];
    private readonly onDone: (result: RewindMenuResult<T> | null) => void;
    private readonly requestRender: () => void;

    constructor(options: MenuOptions<T, Item>) {
        this.items = options.items;
        this.onDone = options.onDone;
        this.requestRender = options.requestRender;
        this.model = new MenuModel(options.items);
    }

    abstract render(width: number): string[];

    handleInput(data: string): void {
        if (matchesKey(data, Key.up)) {
            this.model.move(-1);
        } else if (matchesKey(data, Key.down)) {
            this.model.move(1);
        } else if (matchesKey(data, Key.enter)) {
            this.finish();
            return;
        } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            this.onDone(null);
            return;
        } else if (matchesKey(data, Key.backspace)) {
            this.model.backspaceContext();
        } else if (/^[1-9]$/.test(data)) {
            if (this.model.selectNumber(Number(data))) {
                this.finish();
                return;
            }
        } else if (/^[^\x00-\x1f\x7f]+$/u.test(data)) {
            this.model.appendContext(data);
        } else {
            return;
        }
        this.requestRender();
    }

    invalidate(): void {}

    protected contextLines(width: number): string[] {
        if (!this.model.selected.acceptsContext) return [];
        return ["", line(`  ${foreground(CLAUDE_MUTED, "add context (optional): ")}${this.model.context}`, width)];
    }

    private finish(): void {
        this.onDone({ value: this.model.selected.value, context: this.model.context.trim() });
    }
}

function relativeAge(createdAt: string, now: Date): string {
    const seconds = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function restoreSentence(changes: RestoreChange[]): string | undefined {
    if (changes.length === 0) return undefined;
    const additions = changes.reduce((sum, change) => sum + change.additions, 0);
    const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
    const firstFile = basename(changes[0]!.path);
    const fileLabel = changes.length === 1
        ? firstFile
        : changes.length === 2
            ? `${firstFile} and ${basename(changes[1]!.path)}`
            : `${firstFile} and ${changes.length - 1} other files`;
    return (
        foreground(CLAUDE_MUTED, "The code will be restored ") +
        foreground(CLAUDE_ADDED, `+${additions}`) +
        foreground(CLAUDE_MUTED, " ") +
        foreground(CLAUDE_REMOVED, `-${deletions}`) +
        foreground(CLAUDE_MUTED, ` in ${fileLabel}.`)
    );
}

function actionDescription(value: unknown): string {
    switch (value) {
        case "restore-both":
        case "restore-conversation":
            return "The conversation will be forked.";
        case "summarize-from":
            return "Messages after this point will be summarized.";
        case "summarize-up-to":
            return "Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.";
        default:
            return "The conversation will be unchanged.";
    }
}

function isSummarizeAction(value: unknown): boolean {
    return value === "summarize-from" || value === "summarize-up-to";
}

function restoresCode(value: unknown): boolean {
    return value === "restore-both" || value === "restore-code";
}

export class RewindConfirmationMenu<T> extends InteractiveMenu<T, RewindMenuItem<T>> {
    private readonly prompt: string;
    private readonly createdAt: string;
    private readonly changes: RestoreChange[];
    private readonly now: () => Date;

    constructor(options: MenuOptions<T, RewindMenuItem<T>> & {
        prompt: string;
        createdAt: string;
        changes: RestoreChange[];
        now?: () => Date;
    }) {
        super(options);
        this.prompt = options.prompt;
        this.createdAt = options.createdAt;
        this.changes = options.changes;
        this.now = options.now ?? (() => new Date());
    }

    render(width: number): string[] {
        const selected = this.model.selected;
        const hasChanges = this.changes.length > 0;
        const target = hasChanges ? "" : "the conversation ";
        const lines = [
            divider(width),
            line(`  ${styled(1, CLAUDE_ACCENT, "Rewind")}`, width),
            "",
            line(`  Confirm you want to restore ${target}to the point before you sent this message:`, width),
            "",
            line(`  ${dim("│")} ${this.prompt}`, width),
            line(`  ${dim("│")} ${foreground(CLAUDE_MUTED, `(${relativeAge(this.createdAt, this.now())})`)}`, width),
            "",
            line(`  ${foreground(CLAUDE_MUTED, selected.description ?? actionDescription(selected.value))}`, width),
        ];
        if (!isSummarizeAction(selected.value)) {
            const codeSentence = restoresCode(selected.value) ? restoreSentence(this.changes) : undefined;
            lines.push(line(`  ${codeSentence ?? foreground(CLAUDE_MUTED, "The code will be unchanged.")}`, width));
        }
        lines.push("");
        this.items.forEach((item, index) => {
            const selected = index === this.model.index;
            if (selected) {
                lines.push(line(`  ${foreground(SELECTED_COLOR, "❯")} ${foreground(CLAUDE_MUTED, `${index + 1}. `)}${foreground(SELECTED_COLOR, item.label)}`, width));
                return;
            }
            const prefix = index === this.items.length - 1 && this.model.index < index
                ? `  ${foreground(CLAUDE_MUTED, "↓")} `
                : "    ";
            lines.push(line(`${prefix}${foreground(CLAUDE_MUTED, `${index + 1}. `)}${item.label}`, width));
        });
        lines.push(...this.contextLines(width));
        if (hasChanges) {
            lines.push("", line(`  ${foreground(CLAUDE_MUTED, "⚠ Rewinding does not affect files edited manually or via bash.")}`, width));
        }
        lines.push("");
        return lines;
    }
}

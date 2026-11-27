import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type {
    AcpElicitationQuestion,
    AcpElicitationRequest,
    AcpElicitationResult,
    AcpPermissionRequest,
    AcpPermissionResult,
} from "./protocol.ts";

interface MultiSelectOutcome {
    cancelled: boolean;
    selectedValues: string[];
    wantOther: boolean;
}

class MultiSelectPanel implements Component {
    private readonly title: string;
    private readonly options: readonly { value: string; label: string }[];
    private readonly allowOther: boolean;
    private readonly theme: Theme;
    private readonly keys: KeybindingsManager;
    private readonly tui: TUI;
    private readonly done: (result: MultiSelectOutcome) => void;

    private cursor = 0;
    private readonly selected = new Set<string>();

    constructor(
        title: string,
        options: readonly { value: string; label: string }[],
        allowOther: boolean,
        tui: TUI,
        theme: Theme,
        keys: KeybindingsManager,
        done: (result: MultiSelectOutcome) => void,
    ) {
        this.title = title;
        this.options = options;
        this.allowOther = allowOther;
        this.tui = tui;
        this.theme = theme;
        this.keys = keys;
        this.done = done;
    }

    private totalRows(): number {
        return this.options.length + (this.allowOther ? 2 : 1);
    }

    private confirmRowIndex(): number {
        return this.options.length + (this.allowOther ? 1 : 0);
    }

    private otherRowIndex(): number {
        return this.allowOther ? this.options.length : -1;
    }

    invalidate(): void {}

    handleInput(data: string): void {
        if (this.keys.matches(data, "tui.select.cancel") || data === "\x1b") {
            this.done({ cancelled: true, selectedValues: [], wantOther: false });
            return;
        }
        if (this.keys.matches(data, "tui.select.up") || matchesKey(data, "up") || data === "k") {
            this.cursor = (this.cursor - 1 + this.totalRows()) % this.totalRows();
            this.tui.requestRender();
            return;
        }
        if (this.keys.matches(data, "tui.select.down") || matchesKey(data, "down") || data === "j") {
            this.cursor = (this.cursor + 1) % this.totalRows();
            this.tui.requestRender();
            return;
        }
        if (data === " ") {
            const option = this.options[this.cursor];
            if (option) {
                if (this.selected.has(option.value)) this.selected.delete(option.value);
                else this.selected.add(option.value);
                this.tui.requestRender();
            }
            return;
        }
        if (this.keys.matches(data, "tui.select.confirm") || matchesKey(data, "return") || data === "\r" || data === "\n") {
            if (this.cursor === this.otherRowIndex()) {
                this.done({
                    cancelled: false,
                    selectedValues: this.orderedSelectedValues(),
                    wantOther: true,
                });
                return;
            }
            // 在选项行按 Enter 若尚未勾选任何项，默认直接提交当前聚焦项，降低操作成本。
            if (this.cursor < this.options.length && this.selected.size === 0) {
                const focused = this.options[this.cursor];
                if (focused) this.selected.add(focused.value);
            }
            this.done({
                cancelled: false,
                selectedValues: this.orderedSelectedValues(),
                wantOther: false,
            });
        }
    }

    private orderedSelectedValues(): string[] {
        return this.options
            .filter((opt) => this.selected.has(opt.value))
            .map((opt) => opt.value);
    }

    render(width: number): readonly string[] {
        const safeWidth = Math.max(20, width);
        const lines: string[] = [
            truncateToWidth(this.theme.bold(this.title), safeWidth),
            truncateToWidth(
                this.theme.fg("dim", "↑/↓ 移动 · Space 勾选/取消 · Enter 提交 · Esc 跳过"),
                safeWidth,
            ),
        ];

        for (let index = 0; index < this.options.length; index += 1) {
            const option = this.options[index]!;
            const isFocused = index === this.cursor;
            const isChecked = this.selected.has(option.value);
            const pointer = isFocused ? this.theme.fg("accent", "❯") : " ";
            const box = isChecked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
            const label = isFocused ? this.theme.fg("accent", option.label) : option.label;
            lines.push(truncateToWidth(`${pointer} ${box} ${label}`, safeWidth));
        }

        if (this.allowOther) {
            const isFocused = this.cursor === this.otherRowIndex();
            const pointer = isFocused ? this.theme.fg("accent", "❯") : " ";
            const text = isFocused
                ? this.theme.fg("accent", "补充自定义输入（Other）...")
                : this.theme.fg("muted", "补充自定义输入（Other）...");
            lines.push(truncateToWidth(`${pointer}     ${text}`, safeWidth));
        }

        const confirmFocused = this.cursor === this.confirmRowIndex();
        const confirmPointer = confirmFocused ? this.theme.fg("accent", "❯") : " ";
        const countText = this.selected.size > 0 ? `已选 ${this.selected.size} 项` : "未勾选（跳过本题）";
        const confirmText = confirmFocused
            ? this.theme.fg("success", `确认提交（${countText}）`)
            : this.theme.fg("muted", `确认提交（${countText}）`);
        lines.push(truncateToWidth(`${confirmPointer}     ${confirmText}`, safeWidth));

        return lines;
    }
}

async function askSingleChoiceQuestion(
    ctx: ExtensionContext,
    heading: string,
    question: AcpElicitationQuestion,
): Promise<{ cancelled: boolean; value?: string; other?: string }> {
    const rows: string[] = question.options.map((opt, idx) => `${idx + 1}. ${opt.label}`);
    const otherRow = question.otherKey ? `${rows.length + 1}. 其他（自定义输入）` : undefined;
    if (otherRow) rows.push(otherRow);
    const skipRow = `${rows.length + 1}. 跳过本题`;
    rows.push(skipRow);

    const chosen = await ctx.ui.select(heading, rows);
    if (chosen === undefined) {
        return { cancelled: true };
    }
    if (chosen === skipRow) {
        return { cancelled: false };
    }
    if (otherRow && chosen === otherRow) {
        const text = await ctx.ui.input(heading, "请输入自定义回答");
        if (text === undefined) return { cancelled: true };
        const trimmed = text.trim();
        return trimmed ? { cancelled: false, other: trimmed } : { cancelled: false };
    }

    const index = rows.indexOf(chosen);
    const option = question.options[index];
    return option ? { cancelled: false, value: option.value } : { cancelled: false };
}

async function askMultiChoiceQuestion(
    ctx: ExtensionContext,
    heading: string,
    question: AcpElicitationQuestion,
): Promise<{ cancelled: boolean; values?: string[]; other?: string }> {
    if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
        const outcome = await ctx.ui.custom<MultiSelectOutcome>(
            (tui, theme, keys, done) => new MultiSelectPanel(
                heading,
                question.options,
                Boolean(question.otherKey),
                tui,
                theme,
                keys,
                done,
            ),
            { blocked: { kind: "question", message: heading } },
        );
        if (!outcome || outcome.cancelled) {
            return { cancelled: true };
        }
        let other: string | undefined;
        if (outcome.wantOther && question.otherKey) {
            const text = await ctx.ui.input(`${heading}（自定义补充）`, "请输入自定义回答");
            if (text?.trim()) other = text.trim();
        }
        return {
            cancelled: false,
            values: outcome.selectedValues.length > 0 ? outcome.selectedValues : undefined,
            other,
        };
    }

    // 非 TUI 回退：通过输入框输入编号（逗号分隔）或文本。
    const summary = question.options.map((opt, idx) => `${idx + 1}. ${opt.label}`).join(" | ");
    const raw = await ctx.ui.input(`${heading}\n多选请输入编号（逗号分隔）：${summary}`);
    if (raw === undefined) return { cancelled: true };
    const trimmed = raw.trim();
    if (!trimmed) return { cancelled: false };

    const selectedValues: string[] = [];
    for (const token of trimmed.split(/[,，\s]+/).filter(Boolean)) {
        const index = Number(token) - 1;
        const option = Number.isInteger(index) ? question.options[index] : undefined;
        if (option && !selectedValues.includes(option.value)) {
            selectedValues.push(option.value);
        }
    }
    if (selectedValues.length > 0) {
        return { cancelled: false, values: selectedValues };
    }
    return question.otherKey ? { cancelled: false, other: trimmed } : { cancelled: false };
}

/** 在 Pi TUI 中向用户展示 Antigravity `ask_question` 问卷，并返回 ACP `elicitation/create` 响应。 */
export async function promptElicitationQuestions(
    ctx: ExtensionContext,
    request: AcpElicitationRequest,
): Promise<AcpElicitationResult> {
    if (!ctx.hasUI || request.questions.length === 0) {
        return { action: "cancel" };
    }

    const content: Record<string, string | string[]> = {};
    const total = request.questions.length;

    for (let index = 0; index < total; index += 1) {
        const question = request.questions[index]!;
        const prefix = total > 1 ? `[${index + 1}/${total}] ` : "";
        const heading = `${prefix}${question.title}`;

        if (question.options.length === 0) {
            const answer = await ctx.ui.input(heading);
            if (answer === undefined) {
                return Object.keys(content).length > 0
                    ? { action: "accept", content }
                    : { action: "cancel" };
            }
            const trimmed = answer.trim();
            if (trimmed) content[question.id] = trimmed;
            continue;
        }

        if (question.multiSelect) {
            const outcome = await askMultiChoiceQuestion(ctx, heading, question);
            if (outcome.cancelled) {
                return Object.keys(content).length > 0
                    ? { action: "accept", content }
                    : { action: "cancel" };
            }
            if (outcome.values && outcome.values.length > 0) {
                content[question.id] = outcome.values;
            }
            if (outcome.other && question.otherKey) {
                content[question.otherKey] = outcome.other;
            }
            continue;
        }

        const outcome = await askSingleChoiceQuestion(ctx, heading, question);
        if (outcome.cancelled) {
            return Object.keys(content).length > 0
                ? { action: "accept", content }
                : { action: "cancel" };
        }
        if (outcome.value) {
            content[question.id] = outcome.value;
        }
        if (outcome.other && question.otherKey) {
            content[question.otherKey] = outcome.other;
        }
    }

    return { action: "accept", content };
}

/** 在 Pi TUI 中展示 Antigravity 工具权限审批请求（`session/request_permission`）。 */
export async function promptPermissionRequest(
    ctx: ExtensionContext,
    request: AcpPermissionRequest,
): Promise<AcpPermissionResult> {
    if (!ctx.hasUI || request.options.length === 0) {
        return { outcome: { outcome: "cancelled" } };
    }

    const inputPreview = request.rawInput
        ? JSON.stringify(request.rawInput).slice(0, 140)
        : "";
    const title = inputPreview
        ? `Antigravity 权限请求：${request.title}\n${inputPreview}`
        : `Antigravity 权限请求：${request.title}`;
    const rows = request.options.map((opt, idx) => `${idx + 1}. ${opt.name}`);
    const selected = await ctx.ui.select(title, rows);
    if (selected === undefined) {
        return { outcome: { outcome: "cancelled" } };
    }
    const chosen = request.options[rows.indexOf(selected)];
    if (!chosen) {
        return { outcome: { outcome: "cancelled" } };
    }
    return {
        outcome: {
            outcome: "selected",
            optionId: chosen.optionId,
        },
    };
}

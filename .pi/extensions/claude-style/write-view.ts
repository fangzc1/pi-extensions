import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import {
    displayPath,
    formatErrorLines,
    normalizeNewlines,
    plural,
    resolveExpandHint,
} from "./format-utils.ts";

const INDENT = "     ";

export interface ClaudeWriteTheme {
    fg: Theme["fg"];
    bold: Theme["bold"];
}

export interface WriteViewModel {
    path: string;
    content: string;
    lines: string[];
    phase: "preview" | "success" | "error";
    error?: string;
}

function normalizeContent(content: string): string {
    return normalizeNewlines(content).replace(/\t/gu, "    ");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
    let end = lines.length;
    while (end > 0 && lines[end - 1] === "") end--;
    return lines.slice(0, end);
}

export function getExpandHint(): string {
    return resolveExpandHint();
}

export function createWriteViewModel(
    path: string,
    content: string,
    phase: WriteViewModel["phase"],
    error?: string,
    cwd?: string,
): WriteViewModel {
    const normalized = normalizeContent(content);
    return {
        path: displayPath(path, cwd),
        content: normalized,
        lines: trimTrailingEmptyLines(normalized.split("\n")),
        phase,
        error,
    };
}

/** Claude Code 风格 Write：折叠态仅展示去重统计行，展开态展示带行号与语法高亮的完整代码。 */
export class ClaudeWriteView implements Component {
    private expanded = false;
    private expandHint = resolveExpandHint();
    private model: WriteViewModel;
    private theme: ClaudeWriteTheme;

    constructor(model: WriteViewModel, theme: ClaudeWriteTheme) {
        this.model = model;
        this.theme = theme;
    }

    setModel(model: WriteViewModel): void {
        this.model = model;
    }

    setTheme(theme: ClaudeWriteTheme): void {
        this.theme = theme;
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
    }

    setExpandHint(hint: string): void {
        this.expandHint = hint;
    }

    invalidate(): void {
        // 不缓存 ANSI 文本，Pi 切换主题后由 renderer 注入最新 Theme。
    }

    render(width: number): string[] {
        if (width <= 0) return [];

        const statusColor =
            this.model.phase === "error" ? "error" : this.model.phase === "preview" ? "warning" : "success";
        const header =
            this.theme.fg(statusColor, "⏺") +
            " " +
            this.theme.bold("write") +
            `(${this.theme.fg("accent", this.model.path)})`;
        const output = [truncateToWidth(header, width, "…")];

        if (this.model.phase === "error") {
            const message = this.model.error || "Write failed";
            const errorLines = formatErrorLines(message, this.theme, {
                expanded: this.expanded,
                keep: "head",
                expandHint: this.expandHint,
                prefixErrorLabel: false,
            });
            errorLines.forEach((line, index) => {
                const prefix = index === 0 ? "  ⎿  " : INDENT;
                output.push(truncateToWidth(prefix + line, width, "…"));
            });
            return output;
        }

        const count = this.model.lines.length;
        const unit = plural(count, "line");
        if (this.model.phase === "preview") {
            const previewStats =
                this.theme.fg("muted", "  ⎿  Writing ") +
                this.theme.bold(String(count)) +
                this.theme.fg("muted", ` ${unit}…`);
            output.push(truncateToWidth(previewStats, width, "…"));
        } else {
            let stats =
                this.theme.fg("muted", "  ⎿  Wrote ") +
                this.theme.bold(String(count)) +
                this.theme.fg("muted", ` ${unit}`);
            if (!this.expanded && count > 0) {
                stats += `${this.theme.fg("muted", " (")}${this.expandHint}${this.theme.fg("muted", ")")}`;
            }
            output.push(truncateToWidth(stats, width, "…"));
        }

        if (!this.expanded || count === 0) {
            return output.map((line) =>
                visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…"),
            );
        }

        const language = getLanguageFromPath(this.model.path);
        const highlighted = language
            ? highlightCode(this.model.lines.join("\n"), language)
            : this.model.lines.map((line) => this.theme.fg("toolOutput", line));
        const numberWidth = Math.max(1, String(Math.max(1, count)).length);

        this.model.lines.forEach((line, index) => {
            const code = highlighted[index] ?? this.theme.fg("toolOutput", line);
            const number = this.theme.fg("dim", String(index + 1).padStart(numberWidth, " "));
            output.push(truncateToWidth(`${INDENT}${number} ${code}`, width, "…"));
        });

        return output.map((line) =>
            visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…"),
        );
    }
}

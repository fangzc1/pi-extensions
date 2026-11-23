import {
    getLanguageFromPath,
    highlightCode,
    keyHint,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const INDENT = "     ";
const PREVIEW_LINES = 10;

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
    return content.replace(/\r\n?/gu, "\n").replace(/\t/gu, "    ");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
    let end = lines.length;
    while (end > 0 && lines[end - 1] === "") end--;
    return lines.slice(0, end);
}

export function getExpandHint(): string {
    try {
        // keyHint 在未注册键位时会返回空串，此时用默认文案保证提示语可读。
        return keyHint("app.tools.expand", "to expand") || "ctrl+o to expand";
    } catch {
        // 非 TUI 测试或 Theme 尚未初始化时，保证渲染器仍可安全工作。
        return "ctrl+o to expand";
    }
}

export function createWriteViewModel(
    path: string,
    content: string,
    phase: WriteViewModel["phase"],
    error?: string,
): WriteViewModel {
    const normalized = normalizeContent(content);
    return {
        path,
        content: normalized,
        lines: trimTrailingEmptyLines(normalized.split("\n")),
        phase,
        error,
    };
}

/** 按 Claude Code 实测样式展示 Write：标题、统计、行号与语法高亮，无卡片外框。 */
export class ClaudeWriteView implements Component {
    private model: WriteViewModel;
    private theme: ClaudeWriteTheme;
    private expanded = false;

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
            // 错误信息按行拆分，避免单元素内嵌 \n 破坏差分渲染的行数假设。
            const message = this.model.error || "Write failed";
            message.replace(/\r\n?/gu, "\n").split("\n").forEach((line, index) => {
                const prefix = index === 0 ? "  ⎿  " : INDENT;
                output.push(truncateToWidth(prefix + (line ? this.theme.fg("error", line) : line), width, "…"));
            });
            return output;
        }

        const count = this.model.lines.length;
        const verb = this.model.phase === "preview" ? "Writing" : "Wrote";
        const stats =
            this.theme.fg("muted", `  ⎿  ${verb} `) +
            this.theme.bold(String(count)) +
            this.theme.fg("muted", count === 1 ? " line to " : " lines to ") +
            this.theme.bold(this.model.path);
        output.push(truncateToWidth(stats, width, "…"));

        const visibleLines = this.expanded ? this.model.lines : this.model.lines.slice(0, PREVIEW_LINES);
        const language = getLanguageFromPath(this.model.path);
        const highlighted = language
            ? highlightCode(visibleLines.join("\n"), language)
            : visibleLines.map((line) => this.theme.fg("toolOutput", line));
        const numberWidth = Math.max(1, String(Math.max(1, count)).length);

        visibleLines.forEach((line, index) => {
            const code = highlighted[index] ?? this.theme.fg("toolOutput", line);
            const number = this.theme.fg("dim", String(index + 1).padStart(numberWidth, " "));
            output.push(truncateToWidth(`${INDENT}${number} ${code}`, width, "…"));
        });

        const remaining = count - visibleLines.length;
        if (remaining > 0) {
            const hint = `${INDENT}${this.theme.fg(
                "muted",
                `... (${remaining} more lines, ${count} total,`,
            )} ${getExpandHint()}${this.theme.fg("muted", ")")}`;
            output.push(truncateToWidth(hint, width, "…"));
        }

        return output.map((line) =>
            visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…"),
        );
    }
}

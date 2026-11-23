import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

const DETAIL_INDENT = "     ";
const COLLAPSED_LINES = 10;

export type ClaudeBuiltinToolKind = "read" | "bash" | "powershell" | "grep" | "find" | "ls";
type ToolPhase = "pending" | "success" | "error";

interface ToolResultContent {
    type: string;
    text?: string;
}

interface ToolResult {
    content: ToolResultContent[];
}

export function statusBullet(phase: ToolPhase): string {
    const color = phase === "pending" ? 246 : phase === "success" ? 114 : 211;
    return `\u001b[38;5;${color}m⏺\u001b[39m`;
}

function stringArg(args: unknown, key: string, fallback = ""): string {
    if (typeof args !== "object" || args === null) return fallback;
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" ? value : fallback;
}

function optionalArgument(name: string, value: string): string {
    return value ? `, ${name}: ${JSON.stringify(value)}` : "";
}

function singleLineCommand(command: string): string {
    const normalized = command.replace(/\r\n?/gu, "\n");
    const newline = normalized.indexOf("\n");
    return newline === -1 ? normalized : `${normalized.slice(0, newline)} …`;
}

function formatHeader(kind: ClaudeBuiltinToolKind, args: unknown, theme: Theme): string {
    switch (kind) {
        case "read":
            return `${theme.bold("read")}(${stringArg(args, "path", "unknown")})`;
        case "bash":
            return `${theme.bold("bash")}(${singleLineCommand(stringArg(args, "command"))})`;
        case "powershell":
            return `${theme.bold("powershell")}(${singleLineCommand(stringArg(args, "command"))})`;
        case "grep": {
            const pattern = stringArg(args, "pattern");
            const path = stringArg(args, "path");
            return `${theme.bold("grep")}(pattern: ${JSON.stringify(pattern)}${optionalArgument("path", path)})`;
        }
        case "find": {
            const pattern = stringArg(args, "pattern");
            const path = stringArg(args, "path");
            return `${theme.bold("find")}(pattern: ${JSON.stringify(pattern)}${optionalArgument("path", path)})`;
        }
        case "ls": {
            const path = stringArg(args, "path", ".");
            return `${theme.bold("ls")}(path: ${JSON.stringify(path)})`;
        }
    }
}

function textOutput(result: ToolResult | undefined): string {
    if (!result) return "";
    return result.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text ?? "")
        .join("\n");
}

function outputLines(output: string): string[] {
    return output.trim() ? output.replace(/\r\n?/gu, "\n").trimEnd().split("\n") : [];
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return count === 1 ? singular : pluralForm;
}

/** Claude Code 工具块：首行状态点，结果使用 ⎿，不绘制默认 Box 背景。 */
export class ClaudeBuiltinToolView implements Component {
    private args: unknown;
    private expanded = false;
    private kind: ClaudeBuiltinToolKind;
    private phase: ToolPhase = "pending";
    private result?: ToolResult;
    private theme: Theme;

    constructor(kind: ClaudeBuiltinToolKind, args: unknown, theme: Theme) {
        this.kind = kind;
        this.args = args;
        this.theme = theme;
    }

    setArgs(args: unknown): void {
        this.args = args;
    }

    setTheme(theme: Theme): void {
        this.theme = theme;
    }

    setResult(result: ToolResult, phase: Exclude<ToolPhase, "pending">, expanded: boolean): void {
        this.result = result;
        this.phase = phase;
        this.expanded = expanded;
    }

    setPending(result: ToolResult | undefined, expanded: boolean): void {
        this.result = result;
        this.phase = "pending";
        this.expanded = expanded;
    }

    invalidate(): void {
        // 每次 render 都使用最新 Theme 和状态，不缓存 ANSI。
    }

    render(width: number): string[] {
        if (width <= 0) return [];
        // Bash/PowerShell 参数可能包含 heredoc 等多行命令。每个数组元素必须严格对应
        // 一个终端物理行，否则差分渲染器会低估组件高度并产生重复标题、旧帧残留和边框错位。
        const headerLines = formatHeader(this.kind, this.args, this.theme)
            .replace(/\r\n?/gu, "\n")
            .split("\n");
        const lines = headerLines.map((line, index) =>
            truncateToWidth(`${index === 0 ? `${statusBullet(this.phase)} ` : ""}${line}`, width, "…"),
        );
        const resultLines = this.renderResult();
        resultLines.forEach((line, index) => {
            const prefix = index === 0 ? "  ⎿  " : DETAIL_INDENT;
            lines.push(truncateToWidth(prefix + line, width, "…"));
        });
        return lines;
    }

    private renderResult(): string[] {
        const output = textOutput(this.result);
        if (this.phase === "error") {
            const message = output.trim() || "Tool failed";
            const labeled = message.startsWith("Error:") ? message : `Error: ${message}`;
            // 错误输出必须按行拆分：单个元素内嵌 \n 会破坏 TUI “一行一元素”的差分渲染约定，
            // 导致后续行不左对齐、旧帧残留和边框横线错位。
            return labeled.replace(/\r\n?/gu, "\n").split("\n").map((line) =>
                line ? this.theme.fg("error", line) : line,
            );
        }
        if (this.phase === "pending") {
            if ((this.kind === "bash" || this.kind === "powershell") && output.trim()) {
                return this.renderOutput(output);
            }
            const label = this.kind === "read" ? "Reading…" : this.kind === "bash" || this.kind === "powershell" ? "Running…" : "Searching…";
            return [this.theme.fg("muted", label)];
        }

        if (this.kind === "read") {
            if (this.result?.content.some((item) => item.type === "image")) return ["Read image"];
            const count = output.replace(/\r\n?/gu, "\n").split("\n").length;
            return [`Read ${this.theme.bold(String(count))} ${plural(count, "line")}`];
        }
        if (this.kind === "bash" || this.kind === "powershell") {
            return output.trim() ? this.renderOutput(output) : ["Completed"];
        }

        const lines = outputLines(output);
        if (lines.length === 1 && /^No\s/u.test(lines[0] ?? "")) return lines;
        const noun = this.kind === "grep" ? plural(lines.length, "line") : this.kind === "find" ? plural(lines.length, "file") : plural(lines.length, "entry", "entries");
        const summary = `Found ${this.theme.bold(String(lines.length))} ${noun}`;
        return [summary, ...this.visibleDetails(lines)];
    }

    private renderOutput(output: string): string[] {
        const lines = outputLines(output);
        return lines.length > 0 ? this.visibleDetails(lines) : [""];
    }

    private visibleDetails(lines: string[]): string[] {
        const visible = this.expanded ? lines : lines.slice(0, COLLAPSED_LINES);
        const remaining = lines.length - visible.length;
        return remaining > 0 ? [...visible, this.theme.fg("muted", `… ${remaining} more lines`)] : visible;
    }
}

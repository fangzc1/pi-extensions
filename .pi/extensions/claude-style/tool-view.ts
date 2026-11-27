import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import {
    collapseTail,
    displayPath,
    formatErrorLines,
    normalizeNewlines,
    plural,
    resolveExpandHint,
    splitOutputLines,
} from "./format-utils.ts";

const DETAIL_INDENT = "     ";
const RESULT_PREFIX = "  ⎿  ";
const BASH_PENDING_TAIL_LINES = 2;
const BASH_COLLAPSED_TAIL_LINES = 3;

export type ClaudeBuiltinToolKind = "read" | "bash" | "powershell" | "grep" | "find" | "ls";
type ToolPhase = "pending" | "success" | "error";

interface ToolResultContent {
    type: string;
    text?: string;
}

export interface BuiltinToolResultDetails {
    fullOutputPath?: string;
    matchLimitReached?: number;
    resultLimitReached?: number;
    entryLimitReached?: number;
    truncation?: {
        truncated?: boolean;
        totalLines?: number;
        outputLines?: number;
    };
}

export interface BuiltinToolResult {
    content: ToolResultContent[];
    details?: BuiltinToolResultDetails;
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

function positiveIntArg(args: unknown, key: string): number | undefined {
    if (typeof args !== "object" || args === null) return undefined;
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}

function singleLineCommand(command: string): string {
    const normalized = normalizeNewlines(command);
    const newline = normalized.indexOf("\n");
    return newline === -1 ? normalized : `${normalized.slice(0, newline)} …`;
}

function isExplorationKind(kind: ClaudeBuiltinToolKind): boolean {
    return kind === "read" || kind === "grep" || kind === "find" || kind === "ls";
}

function formatReadRange(args: unknown): string {
    const offset = positiveIntArg(args, "offset");
    const limit = positiveIntArg(args, "limit");
    if (offset !== undefined && limit !== undefined) {
        return `:L${offset}-${offset + limit - 1}`;
    }
    if (offset !== undefined) {
        return `:from L${offset}`;
    }
    if (limit !== undefined) {
        return `:L1-${limit}`;
    }
    return "";
}

function formatHeader(kind: ClaudeBuiltinToolKind, args: unknown, theme: Theme, cwd?: string): string {
    switch (kind) {
        case "read": {
            const path = displayPath(stringArg(args, "path", "unknown"), cwd);
            return `${theme.bold("read")}(${path}${formatReadRange(args)})`;
        }
        case "bash":
            return `${theme.bold("bash")}(${singleLineCommand(stringArg(args, "command"))})`;
        case "powershell":
            return `${theme.bold("powershell")}(${singleLineCommand(stringArg(args, "command"))})`;
        case "grep": {
            const pattern = JSON.stringify(stringArg(args, "pattern"));
            const rawPath = stringArg(args, "path");
            const path = rawPath ? displayPath(rawPath, cwd) : "";
            const target = path && path !== "." ? `, ${path}` : "";
            return `${theme.bold("grep")}(${pattern}${target})`;
        }
        case "find": {
            const pattern = JSON.stringify(stringArg(args, "pattern"));
            const rawPath = stringArg(args, "path");
            const path = rawPath ? displayPath(rawPath, cwd) : "";
            const target = path && path !== "." ? `, ${path}` : "";
            return `${theme.bold("find")}(${pattern}${target})`;
        }
        case "ls": {
            const rawPath = stringArg(args, "path", ".");
            const path = displayPath(rawPath, cwd);
            return `${theme.bold("ls")}(${path})`;
        }
    }
}

function textOutput(result: BuiltinToolResult | undefined): string {
    if (!result) return "";
    return result.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text ?? "")
        .join("\n");
}

/** 剥离 Pi 原生 read 附加在末尾的续读提示块，确保行数统计反映真实文件内容。 */
const READ_CONTINUATION_NOTICE =
    /\n\n\[(?:\d+ more lines in file|Showing lines [^\]]+)\. Use offset=\d+ to continue\.\]\s*$/u;

function countReadLines(output: string, result: BuiltinToolResult | undefined): number {
    const reported = result?.details?.truncation?.outputLines;
    if (typeof reported === "number" && reported >= 0) return reported;
    if (!output) return 0;
    const stripped = normalizeNewlines(output)
        .replace(READ_CONTINUATION_NOTICE, "")
        .replace(/\n$/u, "");
    return stripped === "" ? 0 : stripped.split("\n").length;
}

/** 过滤 Pi 工具附加在尾部的方括号元提示行（如 [50 matches limit reached...]）。 */
function isNoticeLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function summarizeGrep(lines: string[], result: BuiltinToolResult | undefined): {
    compact: string;
    expanded: string;
} {
    const effective = lines.filter((line) => line.trim().length > 0 && !isNoticeLine(line));
    if (effective.length === 0 || (effective.length === 1 && /^No\s/iu.test(effective[0] ?? ""))) {
        return { compact: "no matches", expanded: effective[0] ?? "No matches found" };
    }

    const files = new Set<string>();
    let matchCount = 0;
    for (const line of effective) {
        const matchLine = /^([^:\n]+?):\d+:/u.exec(line);
        if (matchLine?.[1]) {
            files.add(matchLine[1]);
            matchCount++;
            continue;
        }
        // 上下文行（file-line-）不计入匹配次数，但保留文件统计。
        const contextLine = /^([^:\n]+?)-\d+-/u.exec(line);
        if (contextLine?.[1]) {
            files.add(contextLine[1]);
            continue;
        }
        matchCount++;
    }

    const count = matchCount > 0 ? matchCount : effective.length;
    const limitReached = result?.details?.matchLimitReached;
    const countLabel = limitReached ? `${limitReached}+` : String(count);
    const matchNoun = plural(count, "match", "matches");
    const fileSuffix =
        files.size > 0 ? ` in ${files.size} ${plural(files.size, "file")}` : "";
    return {
        compact: `${countLabel} ${matchNoun}${fileSuffix}`,
        expanded: `Found ${countLabel} ${matchNoun}${fileSuffix}`,
    };
}

function summarizeFind(lines: string[], result: BuiltinToolResult | undefined): {
    compact: string;
    expanded: string;
} {
    const effective = lines.filter((line) => line.trim().length > 0 && !isNoticeLine(line));
    if (effective.length === 0 || (effective.length === 1 && /^No\s/iu.test(effective[0] ?? ""))) {
        return { compact: "no files", expanded: effective[0] ?? "No files found" };
    }
    const limitReached = result?.details?.resultLimitReached;
    const countLabel = limitReached ? `${limitReached}+` : String(effective.length);
    const noun = plural(effective.length, "file");
    return {
        compact: `${countLabel} ${noun}`,
        expanded: `Found ${countLabel} ${noun}`,
    };
}

function summarizeLs(lines: string[], result: BuiltinToolResult | undefined): {
    compact: string;
    expanded: string;
} {
    const effective = lines.filter((line) => line.trim().length > 0 && !isNoticeLine(line));
    if (
        effective.length === 0 ||
        (effective.length === 1 && (/^\(empty directory\)$/iu.test(effective[0] ?? "") || /^No\s/iu.test(effective[0] ?? "")))
    ) {
        return { compact: "empty", expanded: effective[0] ?? "(empty directory)" };
    }
    const limitReached = result?.details?.entryLimitReached;
    const countLabel = limitReached ? `${limitReached}+` : String(effective.length);
    const noun = plural(effective.length, "entry", "entries");
    return {
        compact: `${countLabel} ${noun}`,
        expanded: `Found ${countLabel} ${noun}`,
    };
}

/** Claude Code 高信噪比工具块：探索类折叠态单行化，命令类尾部优先，无默认 Box 背景。 */
export class ClaudeBuiltinToolView implements Component {
    private args: unknown;
    private cwd?: string;
    private expanded = false;
    private expandHint = resolveExpandHint();
    private kind: ClaudeBuiltinToolKind;
    private phase: ToolPhase = "pending";
    private result?: BuiltinToolResult;
    private theme: Theme;

    constructor(kind: ClaudeBuiltinToolKind, args: unknown, theme: Theme, cwd?: string) {
        this.kind = kind;
        this.args = args;
        this.theme = theme;
        this.cwd = cwd;
    }

    setArgs(args: unknown): void {
        this.args = args;
    }

    setTheme(theme: Theme): void {
        this.theme = theme;
    }

    setCwd(cwd: string | undefined): void {
        this.cwd = cwd;
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
    }

    setExpandHint(hint: string): void {
        this.expandHint = hint;
    }

    setResult(result: BuiltinToolResult, phase: Exclude<ToolPhase, "pending">, expanded: boolean): void {
        this.result = result;
        this.phase = phase;
        this.expanded = expanded;
    }

    setPending(result: BuiltinToolResult | undefined, expanded: boolean): void {
        this.result = result;
        this.phase = "pending";
        this.expanded = expanded;
    }

    invalidate(): void {
        // 每次 render 都使用最新 Theme 和状态，不缓存 ANSI。
    }

    render(width: number): string[] {
        if (width <= 0) return [];
        const headerText = normalizeNewlines(formatHeader(this.kind, this.args, this.theme, this.cwd));
        const headerLines = headerText.split("\n");

        // 探索类工具（read/grep/find/ls）在折叠态且未出错时压缩为严格 1 行，
        // 同时让 pending 与 success 保持相同高度，避免 TUI 差分重绘抖动。
        if (isExplorationKind(this.kind) && !this.expanded && this.phase !== "error") {
            const summary = this.compactExplorationSummary();
            const firstLine = `${statusBullet(this.phase)} ${headerLines[0] ?? ""}${this.theme.fg("muted", ` · ${summary}`)}`;
            return [truncateToWidth(firstLine, width, "…")];
        }

        // Bash/PowerShell 参数可能包含 heredoc 等多行命令。每个数组元素必须严格对应
        // 一个终端物理行，否则差分渲染器会低估组件高度并产生重复标题、旧帧残留和边框错位。
        const lines = headerLines.map((line, index) =>
            truncateToWidth(`${index === 0 ? `${statusBullet(this.phase)} ` : ""}${line}`, width, "…"),
        );
        const resultLines = this.renderResult();
        resultLines.forEach((line, index) => {
            const prefix = index === 0 ? RESULT_PREFIX : DETAIL_INDENT;
            lines.push(truncateToWidth(prefix + line, width, "…"));
        });
        return lines;
    }

    private compactExplorationSummary(): string {
        if (this.phase === "pending") {
            if (this.kind === "read") return "Reading…";
            if (this.kind === "ls") return "Listing…";
            return "Searching…";
        }

        const output = textOutput(this.result);
        if (this.kind === "read") {
            if (this.result?.content.some((item) => item.type === "image")) return "image";
            const count = countReadLines(output, this.result);
            const truncated = this.result?.details?.truncation?.truncated ? " (truncated)" : "";
            return `${count} ${plural(count, "line")}${truncated}`;
        }

        const lines = splitOutputLines(output);
        if (this.kind === "grep") return summarizeGrep(lines, this.result).compact;
        if (this.kind === "find") return summarizeFind(lines, this.result).compact;
        return summarizeLs(lines, this.result).compact;
    }

    private renderResult(): string[] {
        const output = textOutput(this.result);
        const isShell = this.kind === "bash" || this.kind === "powershell";
        if (this.phase === "error") {
            const message = output.trim() || "Tool failed";
            const errorLines = formatErrorLines(message, this.theme, {
                expanded: this.expanded,
                keep: isShell ? "tail" : "head",
                expandHint: this.expandHint,
            });
            return this.appendFullOutputPath(errorLines);
        }

        if (this.phase === "pending") {
            if (isShell && output.trim()) {
                const lines = splitOutputLines(output);
                return collapseTail(lines, BASH_PENDING_TAIL_LINES, this.expanded, this.theme);
            }
            const label =
                this.kind === "read"
                    ? "Reading…"
                    : isShell
                      ? "Running…"
                      : this.kind === "ls"
                        ? "Listing…"
                        : "Searching…";
            return [this.theme.fg("muted", label)];
        }

        if (this.kind === "read") {
            if (this.result?.content.some((item) => item.type === "image")) return ["Read image"];
            const count = countReadLines(output, this.result);
            const truncated = this.result?.details?.truncation?.truncated ? " (truncated)" : "";
            return [`Read ${this.theme.bold(String(count))} ${plural(count, "line")}${truncated}`];
        }

        if (isShell) {
            if (!output.trim()) return ["Completed"];
            const lines = splitOutputLines(output);
            const visible = collapseTail(
                lines,
                BASH_COLLAPSED_TAIL_LINES,
                this.expanded,
                this.theme,
                this.expandHint,
            );
            return this.appendFullOutputPath(visible);
        }

        const lines = splitOutputLines(output);
        if (lines.length === 1 && /^No\s/iu.test(lines[0] ?? "")) return lines;
        const summary =
            this.kind === "grep"
                ? summarizeGrep(lines, this.result).expanded
                : this.kind === "find"
                  ? summarizeFind(lines, this.result).expanded
                  : summarizeLs(lines, this.result).expanded;
        return [summary, ...lines];
    }

    private appendFullOutputPath(lines: string[]): string[] {
        const fullOutputPath = this.result?.details?.fullOutputPath;
        if (!fullOutputPath) return lines;
        return [...lines, this.theme.fg("muted", `Full output: ${fullOutputPath}`)];
    }
}

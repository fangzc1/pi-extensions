import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    getCapabilities,
    getImageDimensions,
    imageFallback,
    truncateToWidth,
    type Component,
} from "@earendil-works/pi-tui";

import {
    collapseTail,
    formatErrorLines,
    formatExpandedArgs,
    normalizeNewlines,
    plural,
    resolveExpandHint,
    splitOutputLines,
    summarizeObjectArgs,
} from "./format-utils.ts";
import { statusBullet } from "./tool-view.ts";

const RESULT_PREFIX = "  ⎿  ";
const DETAIL_INDENT = "     ";
const MCP_COLLAPSED_TAIL_LINES = 3;

export type ClaudeExternalToolKind = "tool_search" | "mcp";
type ExternalPhase = "pending" | "success" | "error";

export interface ExternalToolResult {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: {
        loaded?: string[];
        fullOutputPath?: string;
        server?: string;
        tool?: string;
    };
}

/** 将 `mcp__<server>__<tool>` 归一化为 `<server>/<tool>`，资源工具保持原名。 */
export function formatMcpToolTitle(toolName: string): string {
    if (!toolName.startsWith("mcp__")) return toolName;
    const stripped = toolName.slice("mcp__".length);
    const separator = stripped.indexOf("__");
    if (separator <= 0 || separator + 2 >= stripped.length) return stripped || toolName;
    return `${stripped.slice(0, separator)}/${stripped.slice(separator + 2)}`;
}

function readQueryArg(args: unknown): string {
    if (typeof args !== "object" || args === null) return "";
    const query = (args as { query?: unknown }).query;
    return typeof query === "string" ? normalizeNewlines(query).replace(/\n/gu, " ").trim() : "";
}

function textOutput(result: ExternalToolResult | undefined): string {
    if (!result) return "";
    return result.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text ?? "")
        .join("\n");
}

function summarizeToolSearch(result: ExternalToolResult | undefined): string {
    const loaded = result?.details?.loaded;
    if (Array.isArray(loaded)) {
        return loaded.length === 0
            ? "no matches"
            : `loaded ${loaded.length} ${plural(loaded.length, "tool")}`;
    }
    const output = textOutput(result).trim();
    if (!output || /^No matching tools/iu.test(output)) return "no matches";
    const match = /^Loaded\s+(\d+)\s+tool/iu.exec(output);
    if (match?.[1]) {
        const count = Number(match[1]);
        return `loaded ${count} ${plural(count, "tool")}`;
    }
    const lines = splitOutputLines(output);
    return lines[0] ?? "done";
}

/** Claude Code 无边框外部工具视图：统一收口 tool_search 与 MCP 工具。 */
export class ClaudeExternalToolView implements Component {
    private args: unknown;
    private expanded = false;
    private expandHint = resolveExpandHint();
    private kind: ClaudeExternalToolKind;
    private phase: ExternalPhase = "pending";
    private result?: ExternalToolResult;
    private showImages = true;
    private theme: Theme;
    private toolName: string;

    constructor(kind: ClaudeExternalToolKind, toolName: string, args: unknown, theme: Theme) {
        this.kind = kind;
        this.toolName = toolName;
        this.args = args;
        this.theme = theme;
    }

    setArgs(args: unknown): void {
        this.args = args;
    }

    setTheme(theme: Theme): void {
        this.theme = theme;
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
    }

    setExpandHint(hint: string): void {
        this.expandHint = hint;
    }

    setShowImages(showImages: boolean): void {
        this.showImages = showImages;
    }

    setPending(result: ExternalToolResult | undefined, expanded: boolean): void {
        this.result = result;
        this.phase = "pending";
        this.expanded = expanded;
    }

    setResult(
        result: ExternalToolResult,
        phase: Exclude<ExternalPhase, "pending">,
        expanded: boolean,
    ): void {
        this.result = result;
        this.phase = phase;
        this.expanded = expanded;
    }

    invalidate(): void {
        // 每次 render 实时读取主题和状态，不缓存 ANSI。
    }

    render(width: number): string[] {
        if (width <= 0) return [];
        const bullet = statusBullet(this.phase);

        if (this.kind === "tool_search") {
            return this.renderToolSearch(width, bullet);
        }
        return this.renderMcp(width, bullet);
    }

    private renderToolSearch(width: number, bullet: string): string[] {
        const query = readQueryArg(this.args);
        const header = `${this.theme.bold("tool_search")}(${query ? JSON.stringify(query) : ""})`;

        if (!this.expanded && this.phase !== "error") {
            const summary =
                this.phase === "pending" ? "Searching…" : summarizeToolSearch(this.result);
            return [
                truncateToWidth(
                    `${bullet} ${header}${this.theme.fg("muted", ` · ${summary}`)}`,
                    width,
                    "…",
                ),
            ];
        }

        const lines = [truncateToWidth(`${bullet} ${header}`, width, "…")];
        const resultLines = this.renderToolSearchResult();
        resultLines.forEach((line, index) => {
            const prefix = index === 0 ? RESULT_PREFIX : DETAIL_INDENT;
            lines.push(truncateToWidth(prefix + line, width, "…"));
        });
        return lines;
    }

    private renderToolSearchResult(): string[] {
        const output = textOutput(this.result);
        if (this.phase === "error") {
            return formatErrorLines(output.trim() || "tool_search failed", this.theme, {
                expanded: this.expanded,
                keep: "head",
                expandHint: this.expandHint,
            });
        }
        if (this.phase === "pending") {
            return [this.theme.fg("muted", "Searching…")];
        }
        const lines = splitOutputLines(output);
        return lines.length > 0 ? lines : [summarizeToolSearch(this.result)];
    }

    private renderMcp(width: number, bullet: string): string[] {
        const label = formatMcpToolTitle(this.toolName);
        const compactArgs = summarizeObjectArgs(this.args);
        const compactHeader = `${this.theme.bold(label)}(${compactArgs})`;

        if (!this.expanded && this.phase === "pending") {
            const progressLines = splitOutputLines(textOutput(this.result));
            const status = progressLines.at(-1) ?? "Running…";
            return [
                truncateToWidth(
                    `${bullet} ${compactHeader}${this.theme.fg("muted", ` · ${status}`)}`,
                    width,
                    "…",
                ),
            ];
        }

        const output = textOutput(this.result);
        const outputLines = splitOutputLines(output);
        const imageLines = this.renderImageLines();
        const fullOutputPath = this.result?.details?.fullOutputPath;

        if (
            !this.expanded &&
            this.phase === "success" &&
            outputLines.length === 0 &&
            imageLines.length === 0 &&
            !fullOutputPath
        ) {
            return [
                truncateToWidth(
                    `${bullet} ${compactHeader}${this.theme.fg("muted", " · done")}`,
                    width,
                    "…",
                ),
            ];
        }

        const headerLines = this.expanded ? this.expandedMcpHeader(label, bullet) : [`${bullet} ${compactHeader}`];
        const lines = headerLines.map((line) => truncateToWidth(line, width, "…"));
        const resultLines = this.renderMcpResult(output, outputLines, imageLines, fullOutputPath);
        resultLines.forEach((line, index) => {
            const prefix = index === 0 ? RESULT_PREFIX : DETAIL_INDENT;
            lines.push(truncateToWidth(prefix + line, width, "…"));
        });
        return lines;
    }

    private expandedMcpHeader(label: string, bullet: string): string[] {
        const argLines = formatExpandedArgs(this.args);
        if (argLines.length === 0) return [`${bullet} ${this.theme.bold(label)}()`];
        if (argLines.length === 1) return [`${bullet} ${this.theme.bold(label)}(${argLines[0]})`];
        return argLines.map((line, index) => {
            if (index === 0) return `${bullet} ${this.theme.bold(label)}(${line}`;
            const suffix = index === argLines.length - 1 ? ")" : "";
            return `${DETAIL_INDENT}${line}${suffix}`;
        });
    }

    private renderMcpResult(
        output: string,
        outputLines: string[],
        imageLines: string[],
        fullOutputPath: string | undefined,
    ): string[] {
        if (this.phase === "error") {
            const lines = formatErrorLines(output.trim() || `${formatMcpToolTitle(this.toolName)} failed`, this.theme, {
                expanded: this.expanded,
                keep: "head",
                expandHint: this.expandHint,
            });
            if (fullOutputPath) lines.push(this.theme.fg("muted", `Full output: ${fullOutputPath}`));
            return lines;
        }
        if (this.phase === "pending") {
            return outputLines.length > 0 ? outputLines : [this.theme.fg("muted", "Running…")];
        }

        const visible = collapseTail(
            outputLines,
            MCP_COLLAPSED_TAIL_LINES,
            this.expanded,
            this.theme,
            this.expandHint,
        );
        const lines = [...visible, ...imageLines];
        if (fullOutputPath) {
            lines.push(this.theme.fg("muted", `Full output: ${fullOutputPath}`));
        }
        return lines.length > 0 ? lines : ["Completed"];
    }

    private renderImageLines(): string[] {
        const images = (this.result?.content ?? []).filter((item) => item.type === "image");
        if (images.length === 0 || (this.showImages && getCapabilities().images)) return [];
        return images.map((image) => {
            const mimeType = image.mimeType ?? "image/unknown";
            const dimensions =
                image.data && image.mimeType
                    ? getImageDimensions(image.data, image.mimeType) ?? undefined
                    : undefined;
            return this.theme.fg("muted", imageFallback(mimeType, dimensions));
        });
    }
}

import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import {
    getCapabilities,
    getImageDimensions,
    imageFallback,
    truncateToWidth,
    type Component,
} from "@earendil-works/pi-tui";

import { statusBullet } from "./tool-view.ts";
import { getExpandHint } from "./write-view.ts";

const RESULT_PREFIX = "  ⎿  ";
const DETAIL_INDENT = "     ";
const COLLAPSED_LINES = 10;
const COLLAPSED_ARGS_CHARS = 80;
/** Pi 在结果首块写入的脚本站头，同时携带挂钟耗时。 */
const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n$/u;
/** 失败脚本把错误详情追加在输出的最后一块。 */
const SCRIPT_ERROR_MARKER = "Script error:\n";

type CodemodePhase = "pending" | "success" | "error";
export type CodemodeCallStatus = "running" | "ok" | "error" | "cancelled";

/** Pi 在 details 中提供的嵌套调用记录（结构取自 CodemodeNestedCall）。 */
export interface CodemodeNestedCall {
    name: string;
    /** Compact JSON of the arguments. */
    args?: string;
    status: CodemodeCallStatus;
    durationMs?: number;
    error?: string;
    cost?: number;
}

export interface CodemodeResult {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: { calls?: CodemodeNestedCall[]; fullOutputPath?: string };
}

function readCode(args: unknown): { code: string; invalid: boolean } {
    if (typeof args !== "object" || args === null) return { code: "", invalid: false };
    const value = (args as { code?: unknown }).code;
    if (value === undefined || value === null) return { code: "", invalid: false };
    if (typeof value !== "string") return { code: "", invalid: true };
    return { code: value, invalid: false };
}

function statusIcon(status: CodemodeCallStatus, theme: Theme): string {
    switch (status) {
        case "running":
            return theme.fg("warning", "…");
        case "ok":
            return theme.fg("success", "✓");
        case "error":
            return theme.fg("error", "✗");
        case "cancelled":
            return theme.fg("muted", "⊘");
    }
}

function plural(count: number, singular: string): string {
    return count === 1 ? singular : `${singular}s`;
}

function formatDuration(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 小额模型调用按两位有效数字展示，避免分类器成本被显示为 $0.00。 */
function formatCost(cost: number): string {
    return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function truncateArgs(args: string): string {
    // 单个数组元素必须严格对应一个物理行，嵌套调用参数先压平换行。
    const flat = args.replace(/\r\n?/gu, " ").replace(/\n/gu, " ");
    return flat.length > COLLAPSED_ARGS_CHARS ? `${flat.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : flat;
}

/** 折叠超出预算的详情行，保持与其它 Claude 风格工具一致的提示语。 */
function collapseDetails(lines: string[], expanded: boolean, theme: Theme): string[] {
    if (expanded || lines.length <= COLLAPSED_LINES) return lines;
    const hidden = lines.length - COLLAPSED_LINES;
    return [
        ...lines.slice(0, COLLAPSED_LINES),
        theme.fg("muted", `... (${hidden} more lines, ${getExpandHint()})`),
    ];
}

/** Claude Code 工具块：脚本首行摘要作为标题，嵌套调用与脚本输出统一使用 ⎿ 缩进。 */
export class ClaudeCodemodeView implements Component {
    private calls: CodemodeNestedCall[] = [];
    private code = "";
    private expanded = false;
    private fullOutputPath?: string;
    private images: Array<{ data?: string; mimeType?: string }> = [];
    private invalid = false;
    private output = "";
    private phase: CodemodePhase = "pending";
    private showImages = true;
    private theme: Theme;
    private wallTime?: string;

    constructor(args: unknown, theme: Theme) {
        this.theme = theme;
        this.setArgs(args);
    }

    setArgs(args: unknown): void {
        const { code, invalid } = readCode(args);
        this.code = code;
        this.invalid = invalid;
    }

    setTheme(theme: Theme): void {
        this.theme = theme;
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
    }

    setShowImages(showImages: boolean): void {
        this.showImages = showImages;
    }

    setPending(result: CodemodeResult | undefined, expanded: boolean): void {
        this.expanded = expanded;
        this.phase = "pending";
        this.applyResult(result);
    }

    setResult(
        result: CodemodeResult,
        phase: Exclude<CodemodePhase, "pending">,
        expanded: boolean,
    ): void {
        this.expanded = expanded;
        this.phase = phase;
        this.applyResult(result);
    }

    invalidate(): void {
        // 每次 render 都使用最新 Theme 和状态，不缓存 ANSI。
    }

    render(width: number): string[] {
        if (width <= 0) return [];
        const lines = this.renderCall(width);
        // 结果每个数组元素必须严格对应一个物理行，否则差分渲染器会低估组件高度并产生旧帧残留。
        this.renderResult().forEach((line, index) => {
            lines.push(
                truncateToWidth(
                    `${index === 0 ? RESULT_PREFIX : DETAIL_INDENT}${line}`,
                    width,
                    "…",
                ),
            );
        });
        return lines;
    }

    private applyResult(result: CodemodeResult | undefined): void {
        this.calls = Array.isArray(result?.details?.calls) ? result.details.calls : [];
        this.fullOutputPath = result?.details?.fullOutputPath;
        const [first, ...rest] = result?.content ?? [];
        const header = typeof first?.text === "string" ? SCRIPT_HEADER.exec(first.text) : null;
        this.wallTime = header?.[1];
        const blocks = header ? rest : (result?.content ?? []);
        this.images = blocks.filter((item) => item.type === "image");
        this.output = blocks
            .filter((item) => item.type === "text" && typeof item.text === "string")
            .map((item) => item.text ?? "")
            .join("\n");
    }

    private renderCall(width: number): string[] {
        const bullet = statusBullet(this.phase);
        const title = this.theme.bold("codemode");
        if (this.invalid) {
            return [
                truncateToWidth(
                    `${bullet} ${title}(${this.theme.fg("error", "[invalid arg]")})`,
                    width,
                    "…",
                ),
            ];
        }

        const codeLines = this.code.replace(/\r\n?/gu, "\n").replace(/\t/gu, "   ").trimEnd().split("\n");
        const firstIndex = codeLines.findIndex((line) => line.trim().length > 0);
        if (firstIndex === -1) {
            return [truncateToWidth(`${bullet} ${title}()`, width, "…")];
        }

        // 折叠态只保留首行摘要，展开态才渲染完整脚本：脚本在流式期间每帧都会重绘。
        if (!this.expanded) {
            const first = codeLines[firstIndex] ?? "";
            const summary = highlightCode(first, "javascript")[0] ?? first;
            const more = codeLines.length > firstIndex + 1 ? " …" : "";
            return [truncateToWidth(`${bullet} ${title}(${summary}${more})`, width, "…")];
        }

        const highlighted = highlightCode(codeLines.join("\n"), "javascript");
        const header = `${title}(${codeLines.map((line, index) => highlighted[index] ?? line).join("\n")})`;
        return header.split("\n").map((line, index) =>
            truncateToWidth(`${index === 0 ? `${bullet} ` : DETAIL_INDENT}${line}`, width, "…"),
        );
    }

    private renderResult(): string[] {
        if (this.phase === "error") {
            return this.errorMessage()
                .replace(/\r\n?/gu, "\n")
                .split("\n")
                .map((line, index) => {
                    const labeled =
                        index === 0 && line.length > 0 && !line.startsWith("Error:")
                            ? `Error: ${line}`
                            : line;
                    return labeled ? this.theme.fg("error", labeled) : labeled;
                });
        }

        const details = [
            ...this.callLines(),
            ...this.costLines(),
            ...this.outputLines(),
            ...this.imageLines(),
        ];
        const lines = [
            this.summaryLine(),
            ...collapseDetails(details, this.expanded, this.theme),
        ];
        // 截断提示在折叠时会隐没，因此完整输出路径始终可见。
        if (this.fullOutputPath) {
            lines.push(this.theme.fg("muted", `Full output: ${this.fullOutputPath}`));
        }
        return lines;
    }

    private summaryLine(): string {
        if (this.phase === "pending") return this.theme.fg("muted", "Running…");
        const count = this.calls.length;
        const label =
            count === 0
                ? "Ran script"
                : `Ran ${this.theme.bold(String(count))} ${plural(count, "tool call")}`;
        return this.wallTime === undefined ? label : `${label} in ${this.wallTime}s`;
    }

    private callLines(): string[] {
        return this.calls.flatMap((call) => {
            const parts = [
                `${statusIcon(call.status, this.theme)} ${this.theme.fg("toolTitle", call.name)}`,
            ];
            if (this.expanded && call.args) {
                parts.push(this.theme.fg("muted", truncateArgs(call.args)));
            }
            if (call.durationMs !== undefined) {
                parts.push(this.theme.fg("dim", formatDuration(call.durationMs)));
            }
            if (call.cost) {
                parts.push(this.theme.fg("dim", formatCost(call.cost)));
            }
            const line = parts.join(" ");
            if (!this.expanded || !call.error) return [line];
            return [
                line,
                ...call.error
                    .replace(/\r\n?/gu, "\n")
                    .split("\n")
                    .map((detail) => this.theme.fg("error", detail)),
            ];
        });
    }

    private costLines(): string[] {
        const priced = this.calls.filter((call) => call.cost);
        // 单次调用的成本已显示在该调用行上，只有多次模型调用才需要合计行。
        if (priced.length < 2) return [];
        const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
        return [this.theme.fg("muted", `Model calls: ${formatCost(total)}`)];
    }

    private outputLines(): string[] {
        return this.output.trim() ? this.output.replace(/\r\n?/gu, "\n").trimEnd().split("\n") : [];
    }

    /** 终端不能内联展示（或用户关闭了图片）时给出文字占位，避免脚本的 image() 输出凭空消失。 */
    private imageLines(): string[] {
        if (this.images.length === 0 || (this.showImages && getCapabilities().images)) return [];
        return this.images.map((image) => {
            const mimeType = image.mimeType ?? "image/unknown";
            const dimensions =
                image.data && image.mimeType
                    ? getImageDimensions(image.data, image.mimeType) ?? undefined
                    : undefined;
            return this.theme.fg("muted", imageFallback(mimeType, dimensions));
        });
    }

    private errorMessage(): string {
        const index = this.output.lastIndexOf(SCRIPT_ERROR_MARKER);
        const message = (index === -1 ? this.output : this.output.slice(index + SCRIPT_ERROR_MARKER.length)).trim();
        return message || "codemode failed";
    }
}

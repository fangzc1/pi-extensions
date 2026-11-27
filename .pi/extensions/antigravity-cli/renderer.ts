import { getMarkdownTheme, type EntryRenderOptions, type MessageRenderOptions, type Theme } from "@earendil-works/pi-coding-agent";
import {
    Box,
    Markdown,
    sliceByColumn,
    stripTerminalSequences,
    Text,
    truncateToWidth,
    visibleWidth,
    type Component,
} from "@earendil-works/pi-tui";
import type { AgyUsage } from "./protocol.ts";
import type { AgyToolStepSummary, AgyTurnProgress, AgyTurnResult } from "./runner.ts";

export const AGY_MESSAGE_TYPE = "antigravity-cli-turn";
export const AGY_ENTRY_TYPE = "antigravity-cli-turn-isolated";
export const AGY_USER_ENTRY_TYPE = "antigravity-cli-user-prompt";

export interface AgyUserPromptRecord {
    prompt: string;
    command: string;
}

const MAX_SYNC_RESPONSE_CHARS = 16_000;
const LIVE_PREVIEW_MAX_LINES = 8;

export interface AgyTurnRecord {
    command: string;
    conversationId?: string;
    userPrompt: string;
    response: string;
    status: string;
    cancelled: boolean;
    error?: string;
    durationMs: number;
    toolSteps: AgyToolStepSummary[];
    usage?: AgyUsage;
    numTurns?: number;
    stderrSummary?: string;
    preambleLines?: string[];
    syncedToMainModel: boolean;
}

export function createTurnRecord(result: AgyTurnResult, syncedToMainModel: boolean): AgyTurnRecord {
    return {
        command: result.command,
        conversationId: result.conversationId,
        userPrompt: result.userPrompt,
        response: result.response,
        status: result.status,
        cancelled: result.cancelled,
        error: result.error,
        durationMs: result.durationMs,
        toolSteps: result.toolSteps.map((step) => ({ ...step })),
        usage: result.usage ? { ...result.usage } : undefined,
        numTurns: result.numTurns,
        stderrSummary: result.stderrSummary,
        preambleLines: result.preambleLines ? [...result.preambleLines] : undefined,
        syncedToMainModel,
    };
}

function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
    return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatUsage(usage: AgyUsage | undefined): string | undefined {
    if (!usage) return undefined;
    const parts: string[] = [];
    if (typeof usage.input_tokens === "number") parts.push(`in ${usage.input_tokens}`);
    if (typeof usage.output_tokens === "number") parts.push(`out ${usage.output_tokens}`);
    if (typeof usage.thinking_tokens === "number" && usage.thinking_tokens > 0) {
        parts.push(`think ${usage.thinking_tokens}`);
    }
    if (typeof usage.total_tokens === "number") parts.push(`total ${usage.total_tokens}`);
    return parts.length > 0 ? parts.join(" / ") : undefined;
}

/**
 * 生成同步进 Pi 主模型上下文的精简问答文本。
 * 工具执行过程留在 details 中用于 TUI 展开展示，不直接灌入主模型上下文。
 */
export function buildSummaryContent(record: AgyTurnRecord): string {
    const prompt = record.userPrompt.trim();
    const rawResponse = record.response.trim();
    let response = rawResponse;
    if (response.length > MAX_SYNC_RESPONSE_CHARS) {
        const head = response.slice(0, Math.floor(MAX_SYNC_RESPONSE_CHARS * 0.7));
        const tail = response.slice(-Math.floor(MAX_SYNC_RESPONSE_CHARS * 0.25));
        response = `${head}\n\n...[回复过长，已为 Pi 主模型上下文精简截断]...\n\n${tail}`;
    }

    const lines = [
        `[Antigravity CLI (${record.command}) 对话摘要]`,
        `用户：${prompt}`,
        "",
        "Antigravity 回复：",
        response || "(无文本回复)",
    ];
    if (record.toolSteps.length > 0) {
        const toolNames = [...new Set(record.toolSteps.map((step) => step.name))];
        lines.push("", `（期间执行了 ${record.toolSteps.length} 次工具调用：${toolNames.join(", ")}）`);
    }
    return lines.join("\n");
}

function phaseLabel(progress: AgyTurnProgress): string {
    if (progress.phase === "waiting_input") {
        return progress.activeTool ? `等待你的响应（${progress.activeTool}）` : "等待你的回答";
    }
    if (progress.activeTool) return `正在调用 ${progress.activeTool}`;
    switch (progress.phase) {
        case "starting":
            return "正在连接 Antigravity CLI";
        case "tool":
            return "正在执行工具";
        case "responding":
            return "正在接收回复";
        default:
            return "思考中";
    }
}

/**
 * 将 AGY 模式标记嵌入输入框上边框的左上角，并完整保留右侧（如 auto-session-name 会话名）。
 * 返回新数组，不原地修改编辑器可能缓存的渲染行。
 */
export function decorateTopBorderWithBadge(
    lines: readonly string[],
    width: number,
    badgeText: string,
    borderColor: (text: string) => string,
    badgeColor: (text: string) => string,
): readonly string[] {
    const cleanBadge = stripTerminalSequences(badgeText).replace(/\s+/g, " ").trim();
    if (!cleanBadge || lines.length === 0 || width < 8) return lines;

    // 兼容 response-timer 等在顶部前置插入状态行的扩展，定位第一条以 ─ 开头的上边框行。
    const borderIndex = lines.findIndex((line) => /^─{4,}/.test(stripTerminalSequences(line)));
    if (borderIndex === -1) return lines;

    const borderLine = lines[borderIndex]!;
    const plainBorder = stripTerminalSequences(borderLine);
    const leadingWidth = plainBorder.match(/^─+/)?.[0].length ?? 0;
    // 预留最左 1 个 ─、文字前后 2 个空格以及右侧至少 1 个 ─ 缓冲，避免碰撞右侧标题。
    const available = Math.min(width, leadingWidth) - 4;
    if (available < 1) return lines;

    const label = ` ${truncateToWidth(cleanBadge, available, "")} `;
    const replaceCols = 1 + visibleWidth(label);
    const remainingCols = Math.max(0, width - replaceCols);
    const tail = sliceByColumn(borderLine, replaceCols, remainingCols);
    const decorated = `${borderColor("─")}${badgeColor(label)}${tail}`;

    const next = [...lines];
    next[borderIndex] = decorated;
    return next;
}

/** 渲染编辑器上方的实时进度 Widget 行。 */
export function renderLiveProgressLines(
    progress: AgyTurnProgress,
    theme: Theme,
    width: number,
    now = Date.now(),
): string[] {
    const safeWidth = Math.max(10, width);
    const elapsed = formatDuration(Math.max(0, now - progress.startedAt));
    const finishedTools = progress.toolSteps.filter((step) => step.state !== "running").length;
    const bullet = theme.fg("accent", "●");
    const header = `${bullet} ${theme.fg("toolTitle", `AGY(${progress.command})`)} ${theme.fg("muted", `处理中 · ${elapsed}`)} ${theme.fg("dim", "· Esc 取消")}`;
    const statusParts = [phaseLabel(progress)];
    if (finishedTools > 0) statusParts.push(`已完成 ${finishedTools} 次工具调用`);
    const lines = [
        truncateToWidth(header, safeWidth),
        truncateToWidth(theme.fg("accent", `  ⎿ ${statusParts.join(" · ")}`), safeWidth),
    ];

    const streamed = progress.streamedText.trim();
    if (streamed) {
        const rawLines = streamed.split(/\r?\n/);
        const tailLines = rawLines.slice(-LIVE_PREVIEW_MAX_LINES);
        if (rawLines.length > LIVE_PREVIEW_MAX_LINES) {
            lines.push(truncateToWidth(theme.fg("dim", "  …"), safeWidth));
        }
        for (const line of tailLines) {
            lines.push(truncateToWidth(theme.fg("muted", `  ${line}`), safeWidth));
        }
    }
    return lines;
}

function renderHeadingWithHint(left: string, hint: string, width: number): string {
    if (!hint) return truncateToWidth(left, width);
    const hintWidth = visibleWidth(hint);
    if (hintWidth >= width) return truncateToWidth(hint, width);
    const leftBudget = Math.max(0, width - hintWidth - 1);
    return `${truncateToWidth(left, leftBudget)} ${hint}`;
}

/** 与 Pi 原生 UserMessageComponent 保持一致的用户消息气泡渲染。 */
export function createUserPromptComponent(
    record: AgyUserPromptRecord,
    theme: Theme,
): Component {
    const box = new Box(1, 1, (content) => theme.bg("userMessageBg", content));
    box.addChild(new Text(theme.fg("userMessageText", record.prompt), 0, 0));
    return box;
}

/** 渲染历史对话卡片，供 CustomMessage 与 CustomEntry 共用。 */
export function createTurnCardComponent(
    record: AgyTurnRecord,
    options: Pick<MessageRenderOptions | EntryRenderOptions, "expanded" | "keyHint">,
    theme: Theme,
): Component {
    return {
        invalidate() {},
        render(width: number): readonly string[] {
            const safeWidth = Math.max(10, width);
            const isSuccess = !record.cancelled && record.status === "SUCCESS";
            const statusColor = isSuccess ? "success" : record.cancelled ? "muted" : "error";
            const statusLabel = isSuccess ? "已完成" : record.cancelled ? "已取消" : `失败(${record.status})`;

            const metaParts = [
                formatDuration(record.durationMs),
                statusLabel,
            ];
            if (record.toolSteps.length > 0) {
                metaParts.push(`${record.toolSteps.length} 次工具调用`);
            }
            if (!record.syncedToMainModel) {
                metaParts.push("未同步主模型");
            }

            const bullet = theme.fg(statusColor, "●");
            const leftHeading = `${bullet} ${theme.fg("toolTitle", `AGY(${record.command})`)} ${theme.fg("muted", metaParts.join(" · "))}`;
            const rawHint = options.expanded ? "" : options.keyHint("app.tools.expand", "展开详情");
            const hint = rawHint ? theme.fg("dim", rawHint.replace(/\x1b\[[0-9;]*m/g, "")) : "";

            const lines: string[] = [renderHeadingWithHint(leftHeading, hint, safeWidth)];

            const body = record.response.trim();
            if (body) {
                const bodyWidth = Math.max(4, safeWidth - 2);
                let bodyLines: readonly string[];
                try {
                    bodyLines = new Markdown(body, 0, 0, getMarkdownTheme()).render(bodyWidth);
                } catch {
                    bodyLines = new Text(body, 0, 0).render(bodyWidth);
                }
                lines.push(...bodyLines.map((line) => `  ${line}`));
            } else if (record.error) {
                const errorLines = new Text(theme.fg("error", record.error), 0, 0).render(Math.max(4, safeWidth - 2));
                lines.push(...errorLines.map((line) => `  ${line}`));
            } else if (record.cancelled) {
                lines.push(truncateToWidth(theme.fg("muted", "  （本轮已取消，上下文已保留）"), safeWidth));
            }

            if (record.error && body) {
                const errorLines = new Text(theme.fg("error", `错误：${record.error}`), 0, 0).render(Math.max(4, safeWidth - 2));
                lines.push(...errorLines.map((line) => `  ${line}`));
            }

            if (options.expanded) {
                if (record.toolSteps.length > 0) {
                    lines.push(theme.fg("dim", "  工具调用："));
                    for (const step of record.toolSteps) {
                        const icon = step.state === "error" ? "✗" : step.state === "done" ? "✓" : "…";
                        const detail = step.summary ? `(${step.summary})` : "";
                        const dur = typeof step.durationSeconds === "number" ? ` ${step.durationSeconds.toFixed(2)}s` : "";
                        const err = step.errorMessage ? ` — ${step.errorMessage}` : "";
                        lines.push(truncateToWidth(
                            theme.fg(step.state === "error" ? "error" : "muted", `    ${icon} ${step.name}${detail}${dur}${err}`),
                            safeWidth,
                        ));
                    }
                }
                const usageText = formatUsage(record.usage);
                if (record.conversationId) {
                    lines.push(truncateToWidth(theme.fg("dim", `  会话 ID：${record.conversationId}`), safeWidth));
                }
                if (usageText) {
                    lines.push(truncateToWidth(theme.fg("dim", `  累计 Token：${usageText}`), safeWidth));
                }
                if (record.preambleLines && record.preambleLines.length > 0) {
                    lines.push(theme.fg("dim", "  前置输出："));
                    for (const pre of record.preambleLines.slice(0, 6)) {
                        lines.push(truncateToWidth(theme.fg("dim", `    ${pre}`), safeWidth));
                    }
                }
                if (record.stderrSummary) {
                    lines.push(theme.fg("dim", "  stderr："));
                    for (const errLine of record.stderrSummary.split(/\r?\n/).slice(0, 6)) {
                        lines.push(truncateToWidth(theme.fg("dim", `    ${errLine}`), safeWidth));
                    }
                }
            }

            return lines;
        },
    };
}

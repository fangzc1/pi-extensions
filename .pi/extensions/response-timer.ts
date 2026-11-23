/**
 * 响应计时扩展 - Codex 风格动画计时器
 *
 * - 使用 agent_start / agent_settled 确保一轮只统计一次
 * - 运行中在编辑器顶部显示：⠼ Working... (Xm Xs • esc to interrupt)，仅 ⠼ 平滑旋转
 * - 完成后在对话历史显示：Done: Xs
 */

import { CustomEditor, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type TUI, type Component } from "@earendil-works/pi-tui";

interface AgentTiming {
    startTime: number;
}

interface TimerHistoryData {
    duration: number;
}

const runtimeState = globalThis as typeof globalThis & {
    __piTimerResponseTimerOwner?: symbol;
};

function acquireRegistration(): (() => void) | undefined {
    if (runtimeState.__piTimerResponseTimerOwner) return undefined;
    const owner = Symbol("pi-timer:response-timer");
    runtimeState.__piTimerResponseTimerOwner = owner;
    return () => {
        if (runtimeState.__piTimerResponseTimerOwner === owner) {
            runtimeState.__piTimerResponseTimerOwner = undefined;
        }
    };
}

/** Braille 旋转动画帧 */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 格式化耗时：<1s 显示 ms，<1m 显示 X.Xs，>=1m 显示 Xm Xs */
function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
}

/** 格式化耗时：始终显示 Xm Xs 风格（用于运行中） */
function formatElapsed(ms: number): string {
    if (ms < 1000) return "0s";
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
}

/** 校验从会话文件恢复的扩展 Entry，避免损坏数据影响 TUI 渲染。 */
function isTimerHistoryData(data: unknown): data is TimerHistoryData {
    if (typeof data !== "object" || data === null) return false;
    const duration = (data as { duration?: unknown }).duration;
    return typeof duration === "number" && Number.isFinite(duration) && duration >= 0;
}

/** 计时行组件 — 由编辑器的 render 循环驱动，避免 setStatus 全量替换闪烁 */
class TimerWidget implements Component {
    private frame = 0;
    private theme: Theme;
    readonly startTime: number;

    constructor(startTime: number, theme: Theme) {
        this.startTime = startTime;
        this.theme = theme;
    }

    render(width: number): string[] {
        this.frame++;
        const spinner = SPINNER[this.frame % SPINNER.length];
        const elapsed = Date.now() - this.startTime;
        const line =
            this.theme.fg("accent", `${spinner} Working...`) +
            this.theme.fg("dim", ` (${formatElapsed(elapsed)} • esc to interrupt)`);

        // 自定义组件必须遵守 TUI 提供的可用宽度，避免窄终端触发整屏渲染崩溃。
        return [visibleWidth(line) > width ? truncateToWidth(line, width) : line];
    }

    invalidate(): void {
        /* 无需缓存 */
    }
}

export default function (pi: ExtensionAPI) {
    const releaseRegistration = acquireRegistration();
    if (!releaseRegistration) return;

    let currentTiming: AgentTiming | null = null;
    let agentActive = false;
    let renderTimer: ReturnType<typeof setInterval> | null = null;
    let latestTui: TUI | null = null;
    let timerWidget: TimerWidget | null = null;
    // EditorComponent.render 返回只读行数组，这里按引用去重即可，不得改写内容。
    const timerLines = new WeakSet<readonly string[]>();

    function clearAllTimers() {
        if (renderTimer !== null) { clearInterval(renderTimer); renderTimer = null; }
    }

    pi.registerEntryRenderer("response-timer-history", (entry, _options, theme) => {
        const text = isTimerHistoryData(entry.data)
            ? `Done: ${formatDuration(entry.data.duration)}`
            : "Done: unavailable";
        return new Text(theme.fg("dim", text), 1, 0);
    });

    pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;

        const previous = ctx.ui.getEditorComponent();
        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
            latestTui = tui;
            const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
            const render = editor.render.bind(editor);
            // 仅装饰渲染，保留 Rewind 等编辑器的输入、焦点和应用级快捷键。
            editor.render = (width) => {
                const lines = render(width);
                if (!timerWidget || timerLines.has(lines)) return lines;
                const result = [...timerWidget.render(width), ...lines];
                // session_start 再次组合已有包装时，避免同一计时行重复出现。
                timerLines.add(result);
                return result;
            };
            return editor;
        });
    });

    pi.on("session_shutdown", async () => {
        clearAllTimers();
        timerWidget = null;
        latestTui?.requestRender();
        latestTui = null;
        releaseRegistration();
    });

    pi.on("agent_start", async (_event, ctx) => {
        if (agentActive) return;

        agentActive = true;
        clearAllTimers();

        // 隐藏 Pi 内建的整行 Working 状态，只保留编辑器顶部的计时行。
        // setWorkingIndicator({ frames: [] }) 只隐藏旋转图标，文本行仍会重复显示。
        ctx.ui.setWorkingVisible(false);

        const startTime = Date.now();
        currentTiming = { startTime };

        // 计时行属于编辑器输出，不再参与其他扩展 Widget 的插入排序。
        timerWidget = new TimerWidget(startTime, ctx.ui.theme);
        latestTui?.requestRender();

        // 每 120ms 请求 TUI 重绘（smooth 60fps-like spinner）
        renderTimer = setInterval(() => {
            if (latestTui) latestTui.requestRender();
        }, 120);
    });

    pi.on("agent_settled", async (_event, ctx) => {
        if (!currentTiming || !agentActive) return;

        clearAllTimers();

        const duration = Date.now() - currentTiming.startTime;

        // 每轮耗时作为 TUI-only Entry 持久化，恢复会话后仍能随历史对话展示。
        pi.appendEntry("response-timer-history", {
            duration,
        } satisfies TimerHistoryData);

        // 结束后移除编辑器顶部计时行；完成耗时已追加到对应的对话历史中。
        timerWidget = null;
        latestTui?.requestRender();

        // 为下一轮恢复 Pi 内建 Working 行；扩展会在 agent_start 时再次隐藏它。
        ctx.ui.setWorkingVisible(true);

        currentTiming = null;
        agentActive = false;
    });
}

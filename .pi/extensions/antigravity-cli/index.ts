import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
    CustomEditor,
    getAgentDir,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
    AGY_EFFORT_LEVELS,
    ConfigStore,
    fetchAvailableModels,
    formatExtraArgs,
    parseExtraArgs,
    probeCommand,
    validateCommand,
    validateEffortLevel,
    validateModelSlug,
    type AgyEffortLevel,
    type AgyModelFamily,
    type AntigravityCliConfig,
    type CommandProbeOptions,
    type CommandProbeResult,
} from "./config.ts";
import {
    AGY_ENTRY_TYPE,
    AGY_MESSAGE_TYPE,
    AGY_USER_ENTRY_TYPE,
    buildSummaryContent,
    createTurnCardComponent,
    createTurnRecord,
    createUserPromptComponent,
    decorateTopBorderWithBadge,
    renderLiveProgressLines,
    type AgyTurnRecord,
    type AgyUserPromptRecord,
} from "./renderer.ts";
import { promptElicitationQuestions, promptPermissionRequest } from "./question-ui.ts";
import { AgyPersistentRunner, type AgyTurnProgress } from "./runner.ts";

export interface AntigravityCliExtensionOptions {
    configStore?: ConfigStore;
    probeOptions?: CommandProbeOptions;
    runnerFactory?: (cwd: string, config: AntigravityCliConfig) => AgyPersistentRunner;
}

interface SessionModelOverride {
    model?: string;
    effort?: AgyEffortLevel;
}

const STATUS_KEY = "antigravity-cli";
const WIDGET_KEY = "antigravity-cli-live";
const ESC_BYTE = "\x1b";

const runtimeState = globalThis as typeof globalThis & {
    __piAntigravityCliOwner?: symbol;
};

function acquireRegistration(): (() => void) | undefined {
    if (runtimeState.__piAntigravityCliOwner) return undefined;
    const owner = Symbol("pi-extensions:antigravity-cli");
    runtimeState.__piAntigravityCliOwner = owner;
    return () => {
        if (runtimeState.__piAntigravityCliOwner === owner) {
            runtimeState.__piAntigravityCliOwner = undefined;
        }
    };
}

function formatProbeSummary(command: string, probe: CommandProbeResult): string {
    if (!probe.ok) return probe.error ?? `命令 "${command}" 不可用`;
    if (probe.resolvedMode === "direct") {
        return `已识别可执行文件：${probe.resolvedPath ?? command}`;
    }
    return `已识别为 zshrc ${probe.shellKind ?? "命令"}：${command}（${probe.rcFile ?? "~/.zshrc"}）`;
}

function formatModelSummary(config: Pick<AntigravityCliConfig, "model" | "effort">): string {
    if (config.model && config.effort) return `${config.model}[${config.effort}]`;
    if (config.model) return config.model;
    if (config.effort) return `默认模型[${config.effort}]`;
    return "跟随 agy 默认";
}

function formatStatusText(config: AntigravityCliConfig, busy: boolean): string {
    let target = config.command;
    if (config.model && config.effort) {
        target = `${config.command} · ${config.model}[${config.effort}]`;
    } else if (config.model) {
        target = `${config.command} · ${config.model}`;
    } else if (config.effort) {
        target = `${config.command} · effort:${config.effort}`;
    }
    return `AGY(${target})${busy ? " · 运行中" : ""}`;
}

/**
 * 解析 `/agy` 附带的临时模型与思考级别参数：
 * - `--model <slug>` / `--effort <level>`
 * - 简写 `<model> [effort]`
 */
export function parseEnterArgs(rawArgs: string): {
    ok: true;
    override?: SessionModelOverride;
} | {
    ok: false;
    error: string;
} {
    const parsed = parseExtraArgs(rawArgs);
    if (!parsed.ok) return parsed;
    const tokens = parsed.args;
    if (tokens.length === 0) return { ok: true };

    const override: SessionModelOverride = {};
    const positionals: string[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token === "--model" || token === "-m") {
            const value = tokens[index + 1];
            if (!value) return { ok: false, error: "--model 缺少模型名称" };
            const checked = validateModelSlug(value);
            if (!checked.ok) return checked;
            override.model = checked.value;
            index += 1;
            continue;
        }
        if (token.startsWith("--model=")) {
            const checked = validateModelSlug(token.slice("--model=".length));
            if (!checked.ok) return checked;
            override.model = checked.value;
            continue;
        }
        if (token === "--effort" || token === "-e") {
            const value = tokens[index + 1];
            if (!value) return { ok: false, error: "--effort 缺少思考级别" };
            const checked = validateEffortLevel(value);
            if (!checked.ok) return checked;
            override.effort = checked.value;
            index += 1;
            continue;
        }
        if (token.startsWith("--effort=")) {
            const checked = validateEffortLevel(token.slice("--effort=".length));
            if (!checked.ok) return checked;
            override.effort = checked.value;
            continue;
        }
        if (token.startsWith("-")) {
            return { ok: false, error: `未知选项 "${token}"，支持 --model <slug> 和 --effort <level>` };
        }
        positionals.push(token);
    }

    if (positionals.length > 2) {
        return { ok: false, error: "参数过多；用法：/agy [model] [effort] 或 /agy --model <slug> --effort <level>" };
    }
    if (positionals.length >= 1 && !override.model) {
        const first = positionals[0]!;
        const asEffort = validateEffortLevel(first);
        if (positionals.length === 1 && asEffort.ok && !override.effort) {
            override.effort = asEffort.value;
        } else {
            const checked = validateModelSlug(first);
            if (!checked.ok) return checked;
            override.model = checked.value;
        }
    }
    if (positionals.length === 2 && !override.effort) {
        const checked = validateEffortLevel(positionals[1]!);
        if (!checked.ok) return checked;
        override.effort = checked.value;
    }

    return { ok: true, override };
}

interface SelectChoice<T> {
    label: string;
    value: T;
}

async function choose<T>(
    ctx: ExtensionContext,
    title: string,
    choices: readonly SelectChoice<T>[],
): Promise<T | undefined> {
    const rows = choices.map((choice, index) => `${index + 1}. ${choice.label}`);
    const selected = await ctx.ui.select(title, rows);
    if (selected === undefined) return undefined;
    return choices[rows.indexOf(selected)]?.value;
}

function findFamilyForModel(
    families: readonly AgyModelFamily[] | undefined,
    model: string | undefined,
): AgyModelFamily | undefined {
    if (!families || !model) return undefined;
    const normalized = model.trim();
    return families.find(
        (family) => family.id === normalized || Object.values(family.variants).includes(normalized),
    );
}

export default function antigravityCli(
    pi: ExtensionAPI,
    options: AntigravityCliExtensionOptions = {},
): void {
    const releaseRegistration = acquireRegistration();
    if (!releaseRegistration) return;

    const store = options.configStore ?? new ConfigStore(join(getAgentDir(), "antigravity-cli.json"));
    const probeOptions = options.probeOptions ?? {};
    const createRunner = options.runnerFactory ?? ((cwd: string, config: AntigravityCliConfig) => (
        new AgyPersistentRunner({ cwd, config, probeOptions })
    ));

    let active = false;
    let runner: AgyPersistentRunner | undefined;
    let currentCwd: string | undefined;
    let sessionOverride: SessionModelOverride | undefined;
    let cachedCatalog: { key: string; families: AgyModelFamily[] } | undefined;
    let activeTurnPromise: Promise<void> | undefined;
    let activeProgress: AgyTurnProgress | undefined;
    let interactionOpen = false;
    let widgetTimer: ReturnType<typeof setInterval> | undefined;
    let progressThrottleTimer: ReturnType<typeof setTimeout> | undefined;
    let liveWidgetTui: { requestRender: () => void } | undefined;
    let editorTui: TUI | undefined;
    let editorDecorated = false;
    const decoratedLines = new WeakSet<readonly string[]>();
    let unsubscribeTerminalInput: (() => void) | undefined;
    let activeCtx: ExtensionContext | undefined;

    function loadPersistedConfig(ctx?: ExtensionContext): AntigravityCliConfig {
        const { config, warning } = store.readSafe();
        if (warning && ctx?.hasUI) {
            ctx.ui.notify(warning, "warning");
        }
        return config;
    }

    function getEffectiveConfig(ctx?: ExtensionContext): AntigravityCliConfig {
        const base = loadPersistedConfig(ctx);
        if (!sessionOverride) return base;
        return {
            ...base,
            model: sessionOverride.model ?? base.model,
            effort: sessionOverride.effort ?? base.effort,
        };
    }

    function ensureRunner(cwd: string, config: AntigravityCliConfig): AgyPersistentRunner {
        if (!runner || currentCwd !== cwd) {
            if (runner) void runner.close();
            runner = createRunner(cwd, config);
            currentCwd = cwd;
        }
        return runner;
    }

    /** 包装编辑器上边框渲染：在左上角显示 AGY 标识，保留右侧会话名与其他扩展的编辑器行为。 */
    function installEditorBorderDecorator(ctx: ExtensionContext | undefined): void {
        if (!ctx || ctx.mode !== "tui" || editorDecorated) return;
        if (typeof ctx.ui.getEditorComponent !== "function" || typeof ctx.ui.setEditorComponent !== "function") return;

        editorDecorated = true;
        const previous = ctx.ui.getEditorComponent();
        ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
            editorTui = tui;
            const editor = previous?.(tui, editorTheme, keybindings) ?? new CustomEditor(tui, editorTheme, keybindings);
            const render = editor.render.bind(editor);
            editor.render = (width: number) => {
                const lines = render(width);
                if (!active || decoratedLines.has(lines)) return lines;
                const badgeText = formatStatusText(getEffectiveConfig(), Boolean(runner?.isBusy));
                const borderColor = editor.borderColor ?? editorTheme.borderColor;
                const uiTheme = activeCtx?.ui.theme;
                const badgeColor = uiTheme ? (text: string) => uiTheme.fg("accent", text) : borderColor;
                const result = decorateTopBorderWithBadge(lines, width, badgeText, borderColor, badgeColor);
                if (result !== lines) {
                    decoratedLines.add(result);
                }
                return result;
            };
            return editor;
        });
    }

    function updateStatusBar(ctx: ExtensionContext | undefined): void {
        if (!ctx?.hasUI) return;
        // 状态已移至输入框左上角边框，始终清空底部状态栏避免在右下角重复展示。
        ctx.ui.setStatus(STATUS_KEY, undefined);
        if (active) {
            installEditorBorderDecorator(ctx);
        }
        editorTui?.requestRender();
    }

    function stopLiveUi(ctx: ExtensionContext | undefined): void {
        if (widgetTimer) {
            clearInterval(widgetTimer);
            widgetTimer = undefined;
        }
        if (progressThrottleTimer) {
            clearTimeout(progressThrottleTimer);
            progressThrottleTimer = undefined;
        }
        if (unsubscribeTerminalInput) {
            unsubscribeTerminalInput();
            unsubscribeTerminalInput = undefined;
        }
        activeProgress = undefined;
        liveWidgetTui = undefined;
        if (ctx?.hasUI) {
            ctx.ui.setWidget(WIDGET_KEY, undefined);
        }
    }

    function startLiveUi(ctx: ExtensionContext, initialProgress: AgyTurnProgress): void {
        stopLiveUi(ctx);
        activeProgress = initialProgress;
        if (!ctx.hasUI) return;

        ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
            liveWidgetTui = tui;
            return {
                invalidate() {},
                render(width: number): readonly string[] {
                    if (!activeProgress) return [];
                    return renderLiveProgressLines(activeProgress, theme, width);
                },
            };
        }, { placement: "aboveEditor" });

        // 每 250ms 刷新耗时显示，即使模型尚在思考也能给出明确进度反馈。
        widgetTimer = setInterval(() => {
            liveWidgetTui?.requestRender();
        }, 250);
        widgetTimer.unref?.();

        // 仅在运行且未打开问卷/权限弹窗期间监听单字节 Esc 中断本轮，避免抢占弹窗的 Esc 按键。
        unsubscribeTerminalInput = ctx.ui.onTerminalInput((data: string) => {
            if (data === ESC_BYTE && runner?.isBusy && !interactionOpen) {
                runner.cancelCurrentTurn();
                liveWidgetTui?.requestRender();
                return { consume: true };
            }
            return undefined;
        });
    }

    function scheduleLiveRender(): void {
        if (progressThrottleTimer) return;
        progressThrottleTimer = setTimeout(() => {
            progressThrottleTimer = undefined;
            liveWidgetTui?.requestRender();
        }, 80);
        progressThrottleTimer.unref?.();
    }

    async function loadModelFamilies(
        ctx: ExtensionContext,
        config: AntigravityCliConfig,
        forceRefresh = false,
    ): Promise<AgyModelFamily[] | undefined> {
        const key = `${config.command}\0${config.launchMode}`;
        if (!forceRefresh) {
            if (cachedCatalog?.key === key) {
                return cachedCatalog.families;
            }
            const knownFromSession = runner?.getStatus().command === config.command
                ? runner.getKnownModelFamilies()
                : [];
            if (knownFromSession.length > 0) {
                cachedCatalog = { key, families: knownFromSession };
                return knownFromSession;
            }
        }

        const controller = new AbortController();
        const fetchPromise = fetchAvailableModels(config.command, config.launchMode, {
            cwd: ctx.cwd,
            ...probeOptions,
            signal: controller.signal,
        });

        let fetched: Awaited<typeof fetchPromise>;
        if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
            let closeLoader: (() => void) | undefined;
            const loaderPromise = ctx.ui.custom<void>((_tui, theme, keys, done) => {
                closeLoader = () => done();
                return {
                    invalidate() {},
                    render(width: number) {
                        const safeWidth = Math.max(20, width);
                        return [
                            truncateToWidth(theme.fg("accent", `正在通过 "${config.command} models" 获取可用模型...`), safeWidth),
                            truncateToWidth(theme.fg("dim", "按 Esc 跳过拉取并改为手动输入模型 slug"), safeWidth),
                        ];
                    },
                    handleInput(data: string) {
                        if (keys.matches(data, "tui.select.cancel") || data === ESC_BYTE) {
                            controller.abort();
                            done();
                        }
                    },
                };
            }, { blocked: { kind: "question", message: "获取 Antigravity 模型列表" } });

            fetched = await fetchPromise;
            closeLoader?.();
            await loaderPromise;
        } else {
            fetched = await fetchPromise;
        }

        if (!fetched.ok) {
            if (!fetched.aborted) {
                ctx.ui.notify(`${fetched.error}（已切换为手动输入模型 slug）`, "warning");
            }
            return undefined;
        }
        cachedCatalog = { key, families: fetched.families };
        return fetched.families;
    }

    async function pickEffortForConfig(
        ctx: ExtensionContext,
        config: AntigravityCliConfig,
        families?: readonly AgyModelFamily[],
    ): Promise<AntigravityCliConfig | undefined> {
        const matchedFamily = findFamilyForModel(families, config.model);
        if (matchedFamily && matchedFamily.efforts.length === 0) {
            ctx.ui.notify(`模型 ${matchedFamily.label} 为固定思考预算，不支持设置思考级别。`, "warning");
            if (!config.effort) return undefined;
            const cleared: AntigravityCliConfig = { ...config, effort: undefined };
            return store.write(cleared);
        }

        const supportedLevels = matchedFamily && matchedFamily.efforts.length > 0
            ? matchedFamily.efforts
            : AGY_EFFORT_LEVELS;

        const choices: SelectChoice<AgyEffortLevel | "__default__">[] = [
            { label: "跟随模型默认", value: "__default__" },
            ...supportedLevels.map((level) => ({
                label: config.effort === level ? `${level}（当前）` : level,
                value: level,
            })),
        ];

        const title = matchedFamily
            ? `选择 ${matchedFamily.label} 的思考级别`
            : "选择 Antigravity 思考级别（--effort）";
        const selected = await choose(ctx, title, choices);
        if (!selected) return undefined;

        const nextConfig: AntigravityCliConfig = {
            ...config,
            effort: selected === "__default__" ? undefined : selected,
        };
        const saved = store.write(nextConfig);
        sessionOverride = undefined;
        await runner?.reconfigure(saved);
        updateStatusBar(ctx);
        ctx.ui.notify(
            saved.effort ? `思考级别已设置为 ${saved.effort}` : "思考级别已恢复为跟随模型默认",
            "info",
        );
        return saved;
    }

    async function pickModelAndEffort(
        ctx: ExtensionContext,
        config: AntigravityCliConfig,
    ): Promise<AntigravityCliConfig | undefined> {
        const families = await loadModelFamilies(ctx, config);
        if (!families || families.length === 0) {
            const input = await ctx.ui.input(
                "输入 Antigravity 模型 slug（留空表示跟随 agy 默认，如 gemini-4-neon）",
                config.model ?? "",
            );
            if (input === undefined) return undefined;
            const trimmed = input.trim();
            if (!trimmed) {
                const saved = store.write({ ...config, model: undefined });
                sessionOverride = undefined;
                await runner?.reconfigure(saved);
                updateStatusBar(ctx);
                ctx.ui.notify("模型已恢复为跟随 agy 默认", "info");
                return saved;
            }
            const checked = validateModelSlug(trimmed);
            if (!checked.ok) {
                ctx.ui.notify(checked.error, "warning");
                return undefined;
            }
            const saved = store.write({ ...config, model: checked.value });
            sessionOverride = undefined;
            await runner?.reconfigure(saved);
            updateStatusBar(ctx);
            ctx.ui.notify(`模型已设置为 ${saved.model}`, "info");
            return saved;
        }

        const choices: SelectChoice<string>[] = [
            { label: `跟随 agy 默认模型${!config.model ? "（当前）" : ""}`, value: "__default__" },
            ...families.map((family) => {
                const currentMark = config.model === family.id || Object.values(family.variants).includes(config.model ?? "")
                    ? "（当前）"
                    : "";
                const effortTag = family.efforts.length > 0
                    ? ` [${family.efforts.join("/")}]`
                    : " [固定思考预算]";
                return {
                    label: `${family.label} (${family.id})${effortTag}${currentMark}`,
                    value: family.id,
                };
            }),
            { label: "手动输入模型 slug...", value: "__manual__" },
        ];

        const selected = await choose(ctx, "选择开启 Antigravity 时使用的模型", choices);
        if (!selected) return undefined;

        if (selected === "__default__") {
            const saved = store.write({ ...config, model: undefined });
            sessionOverride = undefined;
            await runner?.reconfigure(saved);
            updateStatusBar(ctx);
            ctx.ui.notify("模型已恢复为跟随 agy 默认", "info");
            return saved;
        }

        if (selected === "__manual__") {
            const input = await ctx.ui.input("输入模型 slug（如 gemini-4-neon 或 claude-opus-5-5）", config.model ?? "");
            if (input === undefined) return undefined;
            const checked = validateModelSlug(input);
            if (!checked.ok) {
                ctx.ui.notify(checked.error, "warning");
                return undefined;
            }
            const saved = store.write({ ...config, model: checked.value });
            sessionOverride = undefined;
            await runner?.reconfigure(saved);
            updateStatusBar(ctx);
            ctx.ui.notify(`模型已设置为 ${saved.model}`, "info");
            return saved;
        }

        const family = families.find((item) => item.id === selected)!;
        if (family.efforts.length === 0) {
            const saved = store.write({ ...config, model: family.id, effort: undefined });
            sessionOverride = undefined;
            await runner?.reconfigure(saved);
            updateStatusBar(ctx);
            ctx.ui.notify(`已选择 ${family.label}（固定思考预算，不传 --effort）`, "info");
            return saved;
        }

        if (family.efforts.length === 1) {
            const onlyEffort = family.efforts[0]!;
            const saved = store.write({ ...config, model: family.id, effort: onlyEffort });
            sessionOverride = undefined;
            await runner?.reconfigure(saved);
            updateStatusBar(ctx);
            ctx.ui.notify(`已选择 ${family.label} · 思考级别 ${onlyEffort}`, "info");
            return saved;
        }

        // 先持久化所选模型，避免用户在紧接着的思考级别选择中按 Esc 导致模型丢失。
        const preservedEffort = config.effort && family.efforts.includes(config.effort)
            ? config.effort
            : undefined;
        let saved = store.write({ ...config, model: family.id, effort: preservedEffort });
        sessionOverride = undefined;
        await runner?.reconfigure(saved);
        updateStatusBar(ctx);

        const effortChoices: SelectChoice<AgyEffortLevel | "__default__">[] = [
            ...family.efforts.map((level) => ({
                label: saved.effort === level ? `${level}（当前）` : level,
                value: level,
            })),
            { label: "跟随模型默认", value: "__default__" },
        ];
        const chosenEffort = await choose(ctx, `选择 ${family.label} 的思考级别（Esc 保持当前）`, effortChoices);
        if (chosenEffort) {
            saved = store.write({
                ...saved,
                effort: chosenEffort === "__default__" ? undefined : chosenEffort,
            });
            await runner?.reconfigure(saved);
            updateStatusBar(ctx);
        }

        ctx.ui.notify(`已配置开启模型：${formatModelSummary(saved)}`, "info");
        return saved;
    }

    async function exitAgyMode(ctx?: ExtensionContext, silent = false): Promise<void> {
        const wasActive = active;
        active = false;
        sessionOverride = undefined;
        stopLiveUi(ctx ?? activeCtx);
        if (runner) {
            await runner.close();
            runner = undefined;
            currentCwd = undefined;
        }
        if (activeTurnPromise) {
            await activeTurnPromise.catch(() => {});
        }
        updateStatusBar(ctx ?? activeCtx);
        if (!silent && ctx?.hasUI) {
            ctx.ui.notify(
                wasActive ? "已退出 Antigravity CLI 模式，后续对话恢复使用主模型。" : "当前已在使用主模型。",
                "info",
            );
        }
    }

    async function enterAgyMode(ctx: ExtensionContext, override?: SessionModelOverride): Promise<void> {
        sessionOverride = override;
        const config = getEffectiveConfig(ctx);
        const instance = ensureRunner(ctx.cwd, config);
        await instance.reconfigure(config);
        const probe = await instance.verifyCommand();
        if (!probe.ok) {
            sessionOverride = undefined;
            ctx.ui.notify(
                `${probe.error ?? `无法找到命令 "${config.command}"`}。请运行 /agy-config 检查底层命令设置。`,
                "error",
            );
            return;
        }
        active = true;
        activeCtx = ctx;
        updateStatusBar(ctx);
        ctx.ui.notify(
            `已切换至 Antigravity CLI 模式（${formatProbeSummary(config.command, probe)}；模型：${formatModelSummary(config)}）。使用 /agy-exit 退出，/agy-config 修改配置。`,
            "info",
        );
    }

    function showStatus(ctx: ExtensionContext): void {
        const config = getEffectiveConfig(ctx);
        const status = runner?.getStatus();
        const lines = [
            `模式：${active ? "Antigravity CLI 接管中" : "Pi 主模型"}`,
            `底层命令：${config.command}（启动方式：${config.launchMode}）`,
            `配置模型 / 思考级别：${formatModelSummary(config)}${sessionOverride ? "（含本次会话覆盖）" : ""}`,
            `附加参数：${formatExtraArgs(config.extraArgs) || "无"}`,
            `同步精简问答给主模型：${config.syncSummaryToMainModel ? "开启" : "关闭"}`,
        ];
        if (status?.model) {
            lines.push(`CLI 实际生效模型：${status.model}`);
        }
        if (status?.conversationId) {
            lines.push(`AGY 会话 ID：${status.conversationId}（累计 ${status.numTurns} 轮）`);
        }
        if (status?.resolvedMode) {
            lines.push(
                `最近探测：${status.resolvedMode === "direct" ? (status.resolvedPath ?? config.command) : `zshrc ${status.shellKind ?? "命令"}`}`,
            );
        }
        ctx.ui.notify(lines.join("\n"), "info");
    }

    async function openConfigMenu(ctx: ExtensionCommandContext): Promise<void> {
        if (!ctx.hasUI) {
            throw new Error("请在交互模式中使用 /agy-config");
        }
        let config = loadPersistedConfig(ctx);

        while (true) {
            const action = await choose(ctx, "Antigravity CLI 配置", [
                { label: `底层命令：${config.command}`, value: "command" as const },
                { label: `开启模型：${config.model ?? "跟随 agy 默认"}`, value: "model" as const },
                { label: `思考级别：${config.effort ?? "跟随默认"}`, value: "effort" as const },
                { label: `附加参数：${formatExtraArgs(config.extraArgs) || "（无）"}`, value: "extraArgs" as const },
                {
                    label: `同步精简问答给主模型：${config.syncSummaryToMainModel ? "开启" : "关闭"}`,
                    value: "sync" as const,
                },
                { label: "测试当前命令探测", value: "probe" as const },
            ]);
            if (!action) return;

            if (action === "command") {
                const input = await ctx.ui.input(
                    "输入底层命令名称或路径（默认 agy，可设为 ~/.zshrc 中的函数如 a 或 a-plain）",
                    config.command,
                );
                if (input === undefined) continue;
                const checked = validateCommand(input);
                if (!checked.ok) {
                    ctx.ui.notify(checked.error, "warning");
                    continue;
                }
                const probe = await probeCommand(checked.value, config.launchMode, {
                    cwd: ctx.cwd,
                    ...probeOptions,
                });
                if (!probe.ok) {
                    const keepAnyway = await ctx.ui.confirm(
                        "命令探测失败，是否仍然保存？",
                        `${probe.error ?? `未找到命令 "${checked.value}"`}\n如果是 ~/.zshrc 函数，请确认已在 ~/.zshrc 中定义。`,
                    );
                    if (!keepAnyway) continue;
                }
                config = store.write({ ...config, command: checked.value });
                cachedCatalog = undefined;
                await runner?.reconfigure(getEffectiveConfig());
                updateStatusBar(ctx);
                ctx.ui.notify(
                    probe.ok
                        ? `底层命令已更新为 "${config.command}"（${formatProbeSummary(config.command, probe)}）`
                        : `底层命令已保存为 "${config.command}"（当前未探测通过）`,
                    probe.ok ? "info" : "warning",
                );
                continue;
            }

            if (action === "model") {
                const updated = await pickModelAndEffort(ctx, config);
                if (updated) config = updated;
                continue;
            }

            if (action === "effort") {
                const families = config.model ? await loadModelFamilies(ctx, config) : undefined;
                const updated = await pickEffortForConfig(ctx, config, families);
                if (updated) config = updated;
                continue;
            }

            if (action === "extraArgs") {
                const input = await ctx.ui.input(
                    "输入附加透传参数（留空清除，例如 --sandbox 或 --add-dir /path）",
                    formatExtraArgs(config.extraArgs),
                );
                if (input === undefined) continue;
                const parsed = parseExtraArgs(input);
                if (!parsed.ok) {
                    ctx.ui.notify(parsed.error, "warning");
                    continue;
                }
                config = store.write({ ...config, extraArgs: parsed.args });
                await runner?.reconfigure(getEffectiveConfig());
                ctx.ui.notify(
                    parsed.args.length > 0 ? `附加参数已更新：${formatExtraArgs(parsed.args)}` : "已清空附加参数",
                    "info",
                );
                continue;
            }

            if (action === "sync") {
                config = store.write({
                    ...config,
                    syncSummaryToMainModel: !config.syncSummaryToMainModel,
                });
                ctx.ui.notify(
                    config.syncSummaryToMainModel
                        ? "已开启：Antigravity 每轮精简问答将同步给主模型。"
                        : "已关闭：Antigravity 对话将与主模型上下文完全隔离。",
                    "info",
                );
                continue;
            }

            if (action === "probe") {
                const probe = await probeCommand(config.command, config.launchMode, {
                    cwd: ctx.cwd,
                    ...probeOptions,
                });
                ctx.ui.notify(formatProbeSummary(config.command, probe), probe.ok ? "info" : "error");
            }
        }
    }

    function dispatchTurn(prompt: string, ctx: ExtensionContext, images?: ImageContent[]): void {
        const config = getEffectiveConfig(ctx);
        const instance = ensureRunner(ctx.cwd, config);
        activeCtx = ctx;

        // input 短路后 Pi 不会自动展示用户气泡，先立刻追加只读展示条目，确保发送瞬间即可见。
        pi.appendEntry<AgyUserPromptRecord>(AGY_USER_ENTRY_TYPE, {
            prompt: prompt || (images?.length ? `[图片附件 × ${images.length}]` : ""),
            command: config.command,
        });

        const initialProgress: AgyTurnProgress = {
            command: config.command,
            conversationId: instance.currentConversationId,
            phase: "starting",
            toolSteps: [],
            streamedText: "",
            startedAt: Date.now(),
        };
        startLiveUi(ctx, initialProgress);
        updateStatusBar(ctx);

        let task: Promise<void> | undefined;
        task = (async () => {
            try {
                await instance.reconfigure(config);
                const result = await instance.sendTurn(prompt, {
                    images,
                    onProgress: (progress) => {
                        activeProgress = progress;
                        scheduleLiveRender();
                    },
                    onElicitation: async (request) => {
                        interactionOpen = true;
                        try {
                            return await promptElicitationQuestions(ctx, request);
                        } finally {
                            interactionOpen = false;
                        }
                    },
                    onPermission: async (request) => {
                        interactionOpen = true;
                        try {
                            return await promptPermissionRequest(ctx, request);
                        } finally {
                            interactionOpen = false;
                        }
                    },
                });

                stopLiveUi(ctx);
                updateStatusBar(ctx);

                // 仅在同步开关开启且本轮产生了有效回复时写入 CustomMessage，避免错误/取消噪声进入主模型上下文。
                const shouldSync = config.syncSummaryToMainModel
                    && !result.cancelled
                    && result.status === "SUCCESS"
                    && result.response.trim().length > 0;
                const record = createTurnRecord(result, shouldSync);

                if (shouldSync) {
                    pi.sendMessage<AgyTurnRecord>(
                        {
                            customType: AGY_MESSAGE_TYPE,
                            content: buildSummaryContent(record),
                            display: true,
                            details: record,
                        },
                        { triggerTurn: false },
                    );
                } else {
                    pi.appendEntry<AgyTurnRecord>(AGY_ENTRY_TYPE, record);
                }
            } catch (error) {
                stopLiveUi(ctx);
                updateStatusBar(ctx);
                const message = error instanceof Error ? error.message : String(error);
                const record: AgyTurnRecord = {
                    command: config.command,
                    conversationId: instance.currentConversationId,
                    userPrompt: prompt,
                    response: "",
                    status: "ERROR",
                    cancelled: false,
                    error: message,
                    durationMs: Date.now() - initialProgress.startedAt,
                    toolSteps: [],
                    syncedToMainModel: false,
                };
                pi.appendEntry<AgyTurnRecord>(AGY_ENTRY_TYPE, record);
                if (ctx.hasUI) {
                    ctx.ui.notify(`Antigravity CLI 执行失败：${message}`, "error");
                }
            } finally {
                if (activeTurnPromise === task) {
                    activeTurnPromise = undefined;
                }
                updateStatusBar(ctx);
            }
        })();

        activeTurnPromise = task;
    }

    pi.registerMessageRenderer<AgyTurnRecord>(AGY_MESSAGE_TYPE, (message, renderOptions, theme) => {
        if (!message.details) return undefined;
        return createTurnCardComponent(message.details, renderOptions, theme);
    });

    pi.registerEntryRenderer<AgyTurnRecord>(AGY_ENTRY_TYPE, (entry, renderOptions, theme) => {
        if (!entry.data) return undefined;
        return createTurnCardComponent(entry.data, renderOptions, theme);
    });

    pi.registerEntryRenderer<AgyUserPromptRecord>(AGY_USER_ENTRY_TYPE, (entry, _renderOptions, theme) => {
        if (!entry.data?.prompt) return undefined;
        return createUserPromptComponent(entry.data, theme);
    });

    pi.registerCommand("agy", {
        description: "切换后续对话由本机 Antigravity CLI 处理（支持 [model] [effort] 或 new / status / config / exit）",
        getArgumentCompletions(prefix: string) {
            const subcommands = [
                { value: "new", label: "new", description: "重置 Antigravity 会话并开启新对话" },
                { value: "status", label: "status", description: "查看当前 Antigravity 接管状态" },
                { value: "config", label: "config", description: "交互式配置底层命令、模型与思考级别" },
                { value: "exit", label: "exit", description: "退出接管模式，恢复主模型处理" },
                { value: "--model ", label: "--model <slug>", description: "临时指定本次开启使用的模型" },
                { value: "--effort ", label: "--effort <level>", description: "临时指定本次开启使用的思考级别" },
            ];
            const trimmed = prefix.trim().toLowerCase();
            return subcommands.filter((item) => item.value.toLowerCase().startsWith(trimmed));
        },
        async handler(args: string, ctx: ExtensionCommandContext) {
            const trimmed = args.trim();
            const lower = trimmed.toLowerCase();
            if (lower === "exit") {
                await exitAgyMode(ctx);
                return;
            }
            if (lower === "config") {
                await openConfigMenu(ctx);
                return;
            }
            if (lower === "status") {
                showStatus(ctx);
                return;
            }
            if (lower === "new") {
                const config = getEffectiveConfig(ctx);
                const instance = ensureRunner(ctx.cwd, config);
                await instance.resetConversation();
                if (!active) {
                    await enterAgyMode(ctx, sessionOverride);
                } else {
                    updateStatusBar(ctx);
                    ctx.ui.notify("已重置 Antigravity CLI 会话，下一条消息将开启新对话。", "info");
                }
                return;
            }

            if (trimmed.length > 0) {
                const parsed = parseEnterArgs(trimmed);
                if (!parsed.ok) {
                    ctx.ui.notify(parsed.error, "warning");
                    return;
                }
                if (active) {
                    sessionOverride = parsed.override;
                    const effective = getEffectiveConfig(ctx);
                    await runner?.reconfigure(effective);
                    updateStatusBar(ctx);
                    ctx.ui.notify(`已切换本次 Antigravity 模型：${formatModelSummary(effective)}`, "info");
                } else {
                    await enterAgyMode(ctx, parsed.override);
                }
                return;
            }

            if (!active) {
                await enterAgyMode(ctx);
                return;
            }

            if (!ctx.hasUI) {
                showStatus(ctx);
                return;
            }

            const choice = await choose(ctx, "当前已处于 Antigravity CLI 模式", [
                { label: "继续当前会话", value: "keep" as const },
                { label: "切换模型 / 思考级别", value: "model" as const },
                { label: "重置会话（开启新对话）", value: "new" as const },
                { label: "修改配置（/agy-config）", value: "config" as const },
                { label: "查看状态", value: "status" as const },
                { label: "退出并恢复主模型（/agy-exit）", value: "exit" as const },
            ]);
            if (choice === "model") {
                await pickModelAndEffort(ctx, loadPersistedConfig(ctx));
            } else if (choice === "new") {
                await runner?.resetConversation();
                updateStatusBar(ctx);
                ctx.ui.notify("已重置 Antigravity CLI 会话，下一条消息将开启新对话。", "info");
            } else if (choice === "config") {
                await openConfigMenu(ctx);
            } else if (choice === "status") {
                showStatus(ctx);
            } else if (choice === "exit") {
                await exitAgyMode(ctx);
            }
        },
    });

    pi.registerCommand("agy-exit", {
        description: "退出 Antigravity CLI 模式，后续对话恢复使用主模型处理",
        async handler(_args: string, ctx: ExtensionCommandContext) {
            await exitAgyMode(ctx);
        },
    });

    pi.registerCommand("agy-config", {
        description: "交互式配置 Antigravity CLI 底层命令、开启模型与思考级别",
        async handler(_args: string, ctx: ExtensionCommandContext) {
            await openConfigMenu(ctx);
        },
    });

    pi.on("input", async (event, ctx) => {
        if (!active) return { action: "continue" };
        if (event.source === "extension") return { action: "continue" };

        const prompt = event.text.trim();
        const images = event.images && event.images.length > 0 ? event.images : undefined;
        if (!prompt && !images) return { action: "handled" };

        if (runner?.isBusy || activeTurnPromise) {
            if (ctx.hasUI) {
                ctx.ui.notify("Antigravity CLI 正在处理当前轮次，请等待完成或按 Esc 取消。", "warning");
            }
            return { action: "handled" };
        }

        dispatchTurn(prompt, ctx, images);
        return { action: "handled" };
    });

    pi.on("session_start", async (_event, ctx) => {
        activeCtx = ctx;
        editorDecorated = false;
        installEditorBorderDecorator(ctx);
        if (active) {
            await exitAgyMode(ctx, true);
        } else {
            updateStatusBar(ctx);
        }
    });

    pi.on("session_before_switch", async (_event, ctx) => {
        if (active || runner) {
            await exitAgyMode(ctx, true);
        }
    });

    pi.on("session_tree", async (_event, ctx) => {
        if (active || runner) {
            await exitAgyMode(ctx, true);
        }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        try {
            await exitAgyMode(ctx, true);
        } finally {
            editorTui = undefined;
            editorDecorated = false;
            releaseRegistration();
        }
    });
}

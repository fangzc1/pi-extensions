import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
    groupModelCatalog,
    probeCommand,
    resolveZshPath,
    resolveZshRcFile,
    type AgyEffortLevel,
    type AgyModelEntry,
    type AgyModelFamily,
    type AntigravityCliConfig,
    type CommandProbeOptions,
    type CommandProbeResult,
} from "./config.ts";
import {
    formatJsonRpcMessage,
    JsonRpcLineParser,
    normalizeAcpUsage,
    parseAcpConfigOptions,
    parseElicitationRequest,
    parsePermissionRequest,
    type AcpConfigOption,
    type AcpElicitationRequest,
    type AcpElicitationResult,
    type AcpPermissionRequest,
    type AcpPermissionResult,
    type AgyUsage,
    type JsonRpcId,
    type JsonRpcIncoming,
} from "./protocol.ts";

export interface AgyToolStepSummary {
    stepIndex: number;
    name: string;
    state: "running" | "done" | "error";
    summary?: string;
    errorMessage?: string;
    durationSeconds?: number;
}

export interface AgyTurnProgress {
    command: string;
    conversationId?: string;
    phase: "starting" | "thinking" | "tool" | "waiting_input" | "responding";
    activeTool?: string;
    toolSteps: AgyToolStepSummary[];
    streamedText: string;
    startedAt: number;
}

export interface AgyTurnResult {
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
}

export interface AgyRunnerStatus {
    runningProcess: boolean;
    inFlight: boolean;
    command: string;
    configuredModel?: string;
    configuredEffort?: AgyEffortLevel;
    resolvedMode?: "direct" | "zsh-rc";
    resolvedPath?: string;
    shellKind?: string;
    conversationId?: string;
    model?: string;
    permissionMode?: string;
    numTurns: number;
    cumulativeUsage?: AgyUsage;
}

export interface AgyTurnCallbacks {
    images?: ImageContent[];
    onProgress?: (snapshot: AgyTurnProgress) => void;
    onElicitation?: (request: AcpElicitationRequest) => Promise<AcpElicitationResult>;
    onPermission?: (request: AcpPermissionRequest) => Promise<AcpPermissionResult>;
}

export interface AgyRunnerOptions {
    cwd: string;
    config: AntigravityCliConfig;
    probeOptions?: CommandProbeOptions;
    gracefulCloseTimeoutMs?: number;
    cancelGraceTimeoutMs?: number;
    rpcTimeoutMs?: number;
}

interface PendingRpc {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
    userPrompt: string;
    startedAt: number;
    cancelled: boolean;
    phase: AgyTurnProgress["phase"];
    activeTool?: string;
    streamedText: string;
    toolOrder: string[];
    toolMap: Map<string, AgyToolStepSummary & { startedAt: number }>;
    preambleLines: string[];
    stderrChunks: string[];
    callbacks: AgyTurnCallbacks;
    cancelTimers: ReturnType<typeof setTimeout>[];
}

const MAX_STDERR_CHARS = 4000;
const MAX_PREAMBLE_LINES = 50;
const EFFORT_SLUG_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 组装传递给 `agy acp` 的启动参数。模型、思考级别与会话续接由 ACP JSON-RPC 协议承载。 */
export function buildAgyArgs(extraArgs: readonly string[]): string[] {
    return ["acp", ...extraArgs];
}

function summarizeToolParameters(params: Record<string, unknown> | undefined): string | undefined {
    if (!params) return undefined;
    const preferredKeys = [
        "CommandLine",
        "command",
        "Path",
        "path",
        "file_path",
        "TargetFile",
        "AbsolutePath",
        "Query",
        "query",
        "SearchPath",
        "Url",
        "url",
    ];
    for (const key of preferredKeys) {
        const value = params[key];
        if (typeof value === "string" && value.trim()) {
            return value.replace(/\s+/g, " ").trim().slice(0, 120);
        }
    }
    for (const value of Object.values(params)) {
        if (typeof value === "string" && value.trim()) {
            return value.replace(/\s+/g, " ").trim().slice(0, 120);
        }
    }
    return undefined;
}

function sendSignalToProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform !== "win32") {
        try {
            process.kill(-pid, signal);
            return;
        } catch {
            // 进程组已退出，回退单进程信号。
        }
    }
    try {
        child.kill(signal);
    } catch {
        // 忽略已退出进程。
    }
}

function joinStderr(chunks: readonly string[]): string | undefined {
    const text = chunks.join("").trim();
    if (!text) return undefined;
    if (text.length <= MAX_STDERR_CHARS) return text;
    return `${text.slice(0, MAX_STDERR_CHARS)}\n...（stderr 已截断）`;
}

/**
 * 基于官方 `agy acp`（Agent Client Protocol stdio JSON-RPC 2.0）的常驻运行器。
 * - 支持 `elicitation/create`（原生承接 `ask_question` 交互问卷）与 `session/request_permission`；
 * - 多轮对话复用常驻进程，免重启通过 `session/set_config_option` 切换模型与思考级别；
 * - 进程异常断开或切命令后保留 `sessionId`，自动通过 `session/resume` 续接会话。
 */
export class AgyPersistentRunner {
    private readonly cwd: string;
    private readonly probeOptions: CommandProbeOptions;
    private readonly gracefulCloseTimeoutMs: number;
    private readonly cancelGraceTimeoutMs: number;
    private readonly rpcTimeoutMs: number;

    private config: AntigravityCliConfig;
    private proc: ChildProcessWithoutNullStreams | undefined;
    private parser = new JsonRpcLineParser();
    private pendingRpcs = new Map<JsonRpcId, PendingRpc>();
    private nextRpcId = 1;
    private closeWaiter: Promise<void> | undefined;
    private lastProbe: CommandProbeResult | undefined;

    private activeTurn: ActiveTurn | undefined;
    private sessionReady = false;
    private configDirty = true;
    private configOptions: AcpConfigOption[] = [];
    private knownModelFamilies: AgyModelFamily[] = [];
    private sessionPreambleLines: string[] = [];

    private conversationId: string | undefined;
    private model: string | undefined;
    private permissionMode: string | undefined;
    private numTurns = 0;
    private cumulativeUsage: AgyUsage | undefined;

    constructor(options: AgyRunnerOptions) {
        this.cwd = options.cwd;
        this.config = {
            ...options.config,
            extraArgs: [...options.config.extraArgs],
        };
        this.probeOptions = options.probeOptions ?? {};
        this.gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? 2500;
        this.cancelGraceTimeoutMs = options.cancelGraceTimeoutMs ?? 2500;
        this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30_000;
    }

    get isBusy(): boolean {
        return this.activeTurn !== undefined;
    }

    get currentConversationId(): string | undefined {
        return this.conversationId;
    }

    /** 返回当前 ACP 会话已上报的模型家族列表（若尚未建立会话则返回空数组）。 */
    getKnownModelFamilies(): AgyModelFamily[] {
        return this.knownModelFamilies.map((family) => ({
            ...family,
            efforts: [...family.efforts],
            variants: { ...family.variants },
        }));
    }

    getStatus(): AgyRunnerStatus {
        return {
            runningProcess: this.proc !== undefined && this.proc.exitCode === null && !this.proc.killed,
            inFlight: this.activeTurn !== undefined,
            command: this.config.command,
            configuredModel: this.config.model,
            configuredEffort: this.config.effort,
            resolvedMode: this.lastProbe?.resolvedMode,
            resolvedPath: this.lastProbe?.resolvedPath,
            shellKind: this.lastProbe?.shellKind,
            conversationId: this.conversationId,
            model: this.model,
            permissionMode: this.permissionMode,
            numTurns: this.numTurns,
            cumulativeUsage: this.cumulativeUsage ? { ...this.cumulativeUsage } : undefined,
        };
    }

    async verifyCommand(): Promise<CommandProbeResult> {
        const result = await probeCommand(this.config.command, this.config.launchMode, {
            cwd: this.cwd,
            ...this.probeOptions,
        });
        this.lastProbe = result;
        return result;
    }

    /**
     * 更新配置：
     * - 仅变更 model / effort 时免重启，通过 `session/set_config_option` 实时生效；
     * - 变更底层命令、启动模式或附加参数时优雅关闭空闲旧进程，保留 conversationId 供下轮续接。
     */
    async reconfigure(nextConfig: AntigravityCliConfig): Promise<void> {
        const processChanged = nextConfig.command !== this.config.command
            || nextConfig.launchMode !== this.config.launchMode
            || nextConfig.extraArgs.join("\0") !== this.config.extraArgs.join("\0");
        const modelChanged = nextConfig.model !== this.config.model
            || nextConfig.effort !== this.config.effort;

        this.config = {
            ...nextConfig,
            extraArgs: [...nextConfig.extraArgs],
        };

        if (processChanged) {
            this.lastProbe = undefined;
            this.configDirty = true;
            if (!this.activeTurn && this.proc) {
                await this.closeProcessGracefully();
            }
            return;
        }

        if (modelChanged) {
            this.configDirty = true;
            if (!this.activeTurn && this.sessionReady && this.proc && this.proc.exitCode === null) {
                await this.applyModelAndEffort().catch(() => {
                    // 若在线更新失败，标记脏并在下一轮重试。
                    this.configDirty = true;
                });
            }
        }
    }

    async resetConversation(): Promise<void> {
        await this.close();
        this.conversationId = undefined;
        this.model = undefined;
        this.permissionMode = undefined;
        this.numTurns = 0;
        this.cumulativeUsage = undefined;
        this.configOptions = [];
        this.configDirty = true;
    }

    /** 发送一轮对话并流式回调进度、问卷交互与权限审批。 */
    async sendTurn(
        prompt: string,
        callbacksOrProgress?: AgyTurnCallbacks | ((snapshot: AgyTurnProgress) => void),
    ): Promise<AgyTurnResult> {
        if (this.activeTurn) {
            throw new Error("Antigravity CLI 正在处理上一轮请求，请等待完成或按 Esc 取消");
        }

        const callbacks: AgyTurnCallbacks = typeof callbacksOrProgress === "function"
            ? { onProgress: callbacksOrProgress }
            : (callbacksOrProgress ?? {});

        const startedAt = Date.now();
        const turn: ActiveTurn = {
            userPrompt: prompt,
            startedAt,
            cancelled: false,
            phase: "starting",
            streamedText: "",
            toolOrder: [],
            toolMap: new Map(),
            preambleLines: [],
            stderrChunks: [],
            callbacks,
            cancelTimers: [],
        };
        this.activeTurn = turn;
        this.emitProgress(turn);

        try {
            await this.ensureSessionReady();
            if (this.sessionPreambleLines.length > 0) {
                turn.preambleLines.push(...this.sessionPreambleLines);
                this.sessionPreambleLines = [];
            }
            if (this.configDirty) {
                await this.applyModelAndEffort();
            }

            turn.phase = "thinking";
            this.emitProgress(turn);

            const contentBlocks: Array<Record<string, unknown>> = [];
            if (prompt.trim()) {
                contentBlocks.push({ type: "text", text: prompt });
            }
            for (const image of callbacks.images ?? []) {
                contentBlocks.push({
                    type: "image",
                    data: image.data,
                    mimeType: image.mimeType,
                });
            }

            // session/prompt 等待整轮模型与所有工具、问卷交互完成，不设短 RPC 超时。
            const rawResult = await this.sendRpcRequest(
                "session/prompt",
                {
                    sessionId: this.conversationId,
                    prompt: contentBlocks,
                },
                0,
            );

            const resultObj = isRecord(rawResult) ? rawResult : {};
            const stopReason = typeof resultObj.stopReason === "string" ? resultObj.stopReason : "end_turn";
            const usage = normalizeAcpUsage(resultObj.usage);
            if (usage) {
                this.cumulativeUsage = usage;
            }
            this.numTurns += 1;

            const cancelled = turn.cancelled || stopReason === "cancelled";
            const status = cancelled ? "INTERRUPTED" : "SUCCESS";

            return {
                command: this.config.command,
                conversationId: this.conversationId,
                userPrompt: prompt,
                response: turn.streamedText,
                status,
                cancelled,
                durationMs: Date.now() - startedAt,
                toolSteps: this.collectToolSteps(turn),
                usage,
                numTurns: this.numTurns,
                stderrSummary: joinStderr(turn.stderrChunks),
                preambleLines: turn.preambleLines.length > 0 ? [...turn.preambleLines] : undefined,
            };
        } catch (error) {
            const stderrSummary = joinStderr(turn.stderrChunks);
            const message = error instanceof Error ? error.message : String(error);
            const cancelled = turn.cancelled;
            return {
                command: this.config.command,
                conversationId: this.conversationId,
                userPrompt: prompt,
                response: turn.streamedText,
                status: cancelled ? "INTERRUPTED" : "ERROR",
                cancelled,
                error: cancelled ? undefined : (stderrSummary && !message.includes(stderrSummary) ? `${message}：${stderrSummary}` : message),
                durationMs: Date.now() - startedAt,
                toolSteps: this.collectToolSteps(turn),
                stderrSummary,
                preambleLines: turn.preambleLines.length > 0 ? [...turn.preambleLines] : undefined,
            };
        } finally {
            for (const timer of turn.cancelTimers) {
                clearTimeout(timer);
            }
            if (this.activeTurn === turn) {
                this.activeTurn = undefined;
            }
        }
    }

    /** 优雅取消当前轮次：优先发送 ACP `session/cancel`，超时兜底清理进程组并保留 conversationId。 */
    cancelCurrentTurn(): boolean {
        const turn = this.activeTurn;
        if (!turn) return false;
        if (turn.cancelled) return true;
        turn.cancelled = true;

        const child = this.proc;
        if (child && child.exitCode === null) {
            if (this.conversationId && !child.stdin.destroyed) {
                this.sendRpcNotification("session/cancel", { sessionId: this.conversationId });
            } else {
                sendSignalToProcessGroup(child, "SIGINT");
            }

            const sigintTimer = setTimeout(() => {
                if (this.activeTurn === turn && this.proc === child && child.exitCode === null) {
                    sendSignalToProcessGroup(child, "SIGINT");
                }
            }, this.cancelGraceTimeoutMs);
            const sigtermTimer = setTimeout(() => {
                if (this.activeTurn === turn && this.proc === child && child.exitCode === null) {
                    sendSignalToProcessGroup(child, "SIGTERM");
                }
            }, this.cancelGraceTimeoutMs + 1500);
            const sigkillTimer = setTimeout(() => {
                if (this.activeTurn === turn && this.proc === child && child.exitCode === null) {
                    sendSignalToProcessGroup(child, "SIGKILL");
                }
            }, this.cancelGraceTimeoutMs + 3000);
            sigintTimer.unref?.();
            sigtermTimer.unref?.();
            sigkillTimer.unref?.();
            turn.cancelTimers.push(sigintTimer, sigtermTimer, sigkillTimer);
        }
        return true;
    }

    async close(): Promise<void> {
        if (this.activeTurn) {
            this.cancelCurrentTurn();
        }
        await this.closeProcessGracefully();
    }

    private async ensureSessionReady(): Promise<void> {
        if (this.proc && this.proc.exitCode === null && !this.proc.killed && this.sessionReady) {
            return;
        }

        if (!this.proc || this.proc.exitCode !== null || this.proc.killed) {
            await this.spawnAcpProcess();
        }

        await this.sendRpcRequest("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
                elicitation: { form: {} },
            },
            clientInfo: {
                name: "pi-antigravity-cli",
                version: "1.0.0",
            },
        });

        let sessionPayload: unknown;
        if (this.conversationId) {
            try {
                sessionPayload = await this.sendRpcRequest("session/resume", {
                    sessionId: this.conversationId,
                    cwd: this.cwd,
                    mcpServers: [],
                });
            } catch {
                // 旧会话不可恢复时自动回退创建新会话，避免彻底阻塞。
                this.conversationId = undefined;
                sessionPayload = await this.sendRpcRequest("session/new", {
                    cwd: this.cwd,
                    mcpServers: [],
                });
            }
        } else {
            sessionPayload = await this.sendRpcRequest("session/new", {
                cwd: this.cwd,
                mcpServers: [],
            });
        }

        this.applySessionMetadata(sessionPayload);
        this.sessionReady = true;
        this.configDirty = true;
    }

    private applySessionMetadata(payload: unknown): void {
        if (!isRecord(payload)) return;
        if (typeof payload.sessionId === "string" && payload.sessionId) {
            this.conversationId = payload.sessionId;
        }
        if (Array.isArray(payload.configOptions)) {
            this.configOptions = parseAcpConfigOptions(payload.configOptions);
            const modelOpt = this.configOptions.find((opt) => opt.id === "model");
            if (modelOpt?.currentValue) this.model = modelOpt.currentValue;
            const modeOpt = this.configOptions.find((opt) => opt.id === "mode");
            if (modeOpt?.currentValue) this.permissionMode = modeOpt.currentValue;
        }
        if (!this.model && isRecord(payload.models) && typeof payload.models.currentModelId === "string") {
            this.model = payload.models.currentModelId;
        }
        if (isRecord(payload.models) && Array.isArray(payload.models.availableModels)) {
            const entries: AgyModelEntry[] = [];
            for (const item of payload.models.availableModels) {
                if (!isRecord(item)) continue;
                if (typeof item.modelId !== "string" || !item.modelId) continue;
                entries.push({
                    slug: item.modelId,
                    label: typeof item.name === "string" && item.name ? item.name : item.modelId,
                });
            }
            if (entries.length > 0) {
                this.knownModelFamilies = groupModelCatalog(entries);
            }
        }
        if (!this.permissionMode && isRecord(payload.modes) && typeof payload.modes.currentModeId === "string") {
            this.permissionMode = payload.modes.currentModeId;
        }
    }

    private async applyModelAndEffort(): Promise<void> {
        if (!this.conversationId) return;
        const desiredModel = this.config.model?.trim();
        let targetEffort = this.config.effort;

        if (desiredModel) {
            const modelOption = this.configOptions.find((opt) => opt.id === "model");
            const availableValues = new Set((modelOption?.options ?? []).map((opt) => opt.value));

            let modelToSend = desiredModel;
            if (availableValues.size > 0 && !availableValues.has(desiredModel)) {
                const suffixMatch = desiredModel.match(EFFORT_SLUG_SUFFIX);
                if (suffixMatch) {
                    const baseModel = suffixMatch[1]!;
                    const impliedEffort = suffixMatch[2]!.toLowerCase() as AgyEffortLevel;
                    if (availableValues.has(baseModel)) {
                        modelToSend = baseModel;
                        targetEffort ??= impliedEffort;
                    }
                }
            } else if (availableValues.size === 0 && targetEffort) {
                const suffixMatch = desiredModel.match(EFFORT_SLUG_SUFFIX);
                if (suffixMatch) {
                    modelToSend = suffixMatch[1]!;
                }
            }

            if (modelOption?.currentValue !== modelToSend) {
                const updated = await this.sendRpcRequest("session/set_config_option", {
                    sessionId: this.conversationId,
                    configId: "model",
                    value: modelToSend,
                });
                if (isRecord(updated) && Array.isArray(updated.configOptions)) {
                    this.configOptions = parseAcpConfigOptions(updated.configOptions);
                }
                this.model = modelToSend;
            }
        }

        if (targetEffort) {
            const thoughtOption = this.configOptions.find((opt) => opt.id === "thought_level");
            const supported = thoughtOption?.options?.map((opt) => opt.value) ?? [];
            const canSetThought = supported.length === 0 || supported.includes(targetEffort);
            if (canSetThought && thoughtOption?.currentValue !== targetEffort) {
                const updated = await this.sendRpcRequest("session/set_config_option", {
                    sessionId: this.conversationId,
                    configId: "thought_level",
                    value: targetEffort,
                });
                if (isRecord(updated) && Array.isArray(updated.configOptions)) {
                    this.configOptions = parseAcpConfigOptions(updated.configOptions);
                }
            }
        }

        this.configDirty = false;
    }

    private async spawnAcpProcess(): Promise<void> {
        const probe = this.lastProbe?.ok ? this.lastProbe : await this.verifyCommand();
        if (!probe.ok || !probe.resolvedMode) {
            throw new Error(probe.error ?? `无法启动命令 "${this.config.command}"`);
        }

        const acpArgs = buildAgyArgs(this.config.extraArgs);
        const env = { ...process.env, ...this.probeOptions.env };
        const detached = process.platform !== "win32";

        let child: ChildProcessWithoutNullStreams;
        if (probe.resolvedMode === "direct") {
            const executable = probe.resolvedPath ?? this.config.command;
            child = spawn(executable, acpArgs, {
                cwd: this.cwd,
                env,
                stdio: ["pipe", "pipe", "pipe"],
                detached,
            });
        } else {
            const zshPath = probe.zshPath ?? resolveZshPath(env);
            const rcFile = probe.rcFile ?? resolveZshRcFile(env);
            const wrapperScript = '[[ -f "$1" ]] && source "$1" >/dev/null 2>&1; "$2" "${@:3}"';
            child = spawn(
                zshPath,
                ["-c", wrapperScript, "pi-agy-wrapper", rcFile, this.config.command, ...acpArgs],
                {
                    cwd: this.cwd,
                    env,
                    stdio: ["pipe", "pipe", "pipe"],
                    detached,
                },
            );
        }

        this.parser.reset();
        this.sessionReady = false;
        this.configOptions = [];
        this.sessionPreambleLines = [];
        this.proc = child;
        this.closeWaiter = new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.once("error", () => resolve());
        });

        child.stdin.on("error", () => {});

        child.stdout.on("data", (chunk: Buffer) => {
            if (this.proc !== child) return;
            for (const incoming of this.parser.push(chunk)) {
                this.handleIncoming(child, incoming);
            }
        });

        child.stderr.on("data", (chunk: Buffer) => {
            if (this.proc !== child) return;
            const text = chunk.toString("utf8");
            if (this.activeTurn && text) {
                this.activeTurn.stderrChunks.push(text);
            }
        });

        child.on("error", (error: Error) => {
            if (this.proc === child) {
                this.proc = undefined;
                this.sessionReady = false;
            }
            this.rejectAllPending(new Error(`启动 "${this.config.command} acp" 失败：${error.message}`));
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
            if (this.proc === child) {
                for (const incoming of this.parser.flush()) {
                    this.handleIncoming(child, incoming);
                }
                this.proc = undefined;
                this.sessionReady = false;
            }
            const reason = signal
                ? `ACP 进程因信号 ${signal} 终止`
                : `ACP 进程意外退出（exit code ${code ?? "unknown"}）`;
            this.rejectAllPending(new Error(reason));
        });
    }

    private handleIncoming(child: ChildProcessWithoutNullStreams, incoming: JsonRpcIncoming): void {
        if (incoming.kind === "noise") {
            const target = this.activeTurn ? this.activeTurn.preambleLines : this.sessionPreambleLines;
            if (target.length < MAX_PREAMBLE_LINES) {
                target.push(incoming.line);
            }
            return;
        }

        if (incoming.kind === "response") {
            const pending = this.pendingRpcs.get(incoming.id);
            if (!pending) return;
            this.pendingRpcs.delete(incoming.id);
            if (pending.timer) clearTimeout(pending.timer);
            if (incoming.error) {
                pending.reject(new Error(incoming.error.message));
            } else {
                pending.resolve(incoming.result);
            }
            return;
        }

        if (incoming.kind === "notification") {
            if (incoming.method === "session/update") {
                this.handleSessionUpdate(incoming.params);
            }
            return;
        }

        if (incoming.kind === "request") {
            void this.handleServerRequest(child, incoming.id, incoming.method, incoming.params);
        }
    }

    private handleSessionUpdate(params: unknown): void {
        if (!isRecord(params)) return;
        const update = isRecord(params.update) ? params.update : undefined;
        if (!update) return;

        const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
        const turn = this.activeTurn;

        if (kind === "config_options_update" && Array.isArray(update.configOptions)) {
            this.configOptions = parseAcpConfigOptions(update.configOptions);
            const modelOpt = this.configOptions.find((opt) => opt.id === "model");
            if (modelOpt?.currentValue) this.model = modelOpt.currentValue;
            return;
        }

        if (!turn) return;

        if (kind === "agent_thought_chunk") {
            if (turn.phase === "starting") {
                turn.phase = "thinking";
                this.emitProgress(turn);
            }
            return;
        }

        if (kind === "agent_message_chunk") {
            const content = isRecord(update.content) ? update.content : undefined;
            const text = typeof content?.text === "string" ? content.text : "";
            if (text) {
                turn.streamedText += text;
                turn.phase = "responding";
                turn.activeTool = undefined;
                this.emitProgress(turn);
            }
            return;
        }

        if (kind === "tool_call" || kind === "tool_call_update") {
            const toolCallId = typeof update.toolCallId === "string"
                ? update.toolCallId
                : `tool-${turn.toolOrder.length}`;
            let existing = turn.toolMap.get(toolCallId);
            const name = typeof update.name === "string" && update.name
                ? update.name
                : typeof update.title === "string" && update.title
                    ? update.title
                    : existing?.name ?? "tool";
            const rawInput = isRecord(update.rawInput)
                ? update.rawInput
                : isRecord(update.args)
                    ? update.args
                    : undefined;
            const summary = summarizeToolParameters(rawInput) ?? existing?.summary;
            const rawStatus = typeof update.status === "string" ? update.status : "in_progress";
            const state: AgyToolStepSummary["state"] = rawStatus === "failed" || rawStatus === "error"
                ? "error"
                : rawStatus === "completed" || rawStatus === "done"
                    ? "done"
                    : "running";

            if (!existing) {
                existing = {
                    stepIndex: turn.toolOrder.length,
                    name,
                    state,
                    summary,
                    startedAt: Date.now(),
                };
                turn.toolOrder.push(toolCallId);
                turn.toolMap.set(toolCallId, existing);
            } else {
                existing.name = name;
                existing.state = state;
                if (summary) existing.summary = summary;
                if (state !== "running" && existing.durationSeconds === undefined) {
                    existing.durationSeconds = (Date.now() - existing.startedAt) / 1000;
                }
            }

            if (state === "running") {
                turn.phase = name === "ask_question" ? "waiting_input" : "tool";
                turn.activeTool = summary ? `${name}(${summary})` : name;
            } else if (turn.activeTool?.startsWith(name)) {
                turn.activeTool = undefined;
                turn.phase = "thinking";
            }
            this.emitProgress(turn);
        }
    }

    private async handleServerRequest(
        child: ChildProcessWithoutNullStreams,
        id: JsonRpcId,
        method: string,
        params: unknown,
    ): Promise<void> {
        const turn = this.activeTurn;

        if (method === "elicitation/create") {
            const request = parseElicitationRequest(params);
            let result: AcpElicitationResult = { action: "cancel" };
            if (turn && turn.callbacks.onElicitation) {
                const prevPhase = turn.phase;
                turn.phase = "waiting_input";
                turn.activeTool = "ask_question";
                this.emitProgress(turn);
                try {
                    result = await turn.callbacks.onElicitation(request);
                } catch {
                    result = { action: "cancel" };
                } finally {
                    if (this.activeTurn === turn) {
                        turn.phase = prevPhase === "waiting_input" ? "thinking" : prevPhase;
                        if (turn.activeTool === "ask_question") turn.activeTool = undefined;
                        this.emitProgress(turn);
                    }
                }
            }
            this.writeJsonRpcResponse(child, id, result);
            return;
        }

        if (method === "session/request_permission") {
            const request = parsePermissionRequest(params);
            let result: AcpPermissionResult = { outcome: { outcome: "cancelled" } };
            if (turn && turn.callbacks.onPermission) {
                const prevPhase = turn.phase;
                turn.phase = "waiting_input";
                turn.activeTool = `权限确认(${request.title})`;
                this.emitProgress(turn);
                try {
                    result = await turn.callbacks.onPermission(request);
                } catch {
                    result = { outcome: { outcome: "cancelled" } };
                } finally {
                    if (this.activeTurn === turn) {
                        turn.phase = prevPhase === "waiting_input" ? "thinking" : prevPhase;
                        turn.activeTool = undefined;
                        this.emitProgress(turn);
                    }
                }
            }
            this.writeJsonRpcResponse(child, id, result);
            return;
        }

        this.writeJsonRpcError(child, id, -32601, `客户端暂不支持 ACP 请求方法：${method}`);
    }

    private writeJsonRpcResponse(child: ChildProcessWithoutNullStreams, id: JsonRpcId, result: unknown): void {
        if (this.proc !== child || child.exitCode !== null || child.stdin.destroyed) return;
        try {
            child.stdin.write(formatJsonRpcMessage({ id, result }), "utf8");
        } catch {
            // 进程已关闭，忽略写入错误。
        }
    }

    private writeJsonRpcError(
        child: ChildProcessWithoutNullStreams,
        id: JsonRpcId,
        code: number,
        message: string,
    ): void {
        if (this.proc !== child || child.exitCode !== null || child.stdin.destroyed) return;
        try {
            child.stdin.write(formatJsonRpcMessage({ id, error: { code, message } }), "utf8");
        } catch {
            // 忽略已关闭管道错误。
        }
    }

    private sendRpcNotification(method: string, params: Record<string, unknown>): void {
        const child = this.proc;
        if (!child || child.exitCode !== null || child.stdin.destroyed) return;
        try {
            child.stdin.write(formatJsonRpcMessage({ method, params }), "utf8");
        } catch {
            // 忽略通知发送失败。
        }
    }

    private sendRpcRequest(
        method: string,
        params: Record<string, unknown>,
        timeoutMs = this.rpcTimeoutMs,
    ): Promise<unknown> {
        const child = this.proc;
        if (!child || child.exitCode !== null || child.stdin.destroyed) {
            return Promise.reject(new Error("Antigravity ACP 进程未运行"));
        }

        const id = this.nextRpcId++;
        return new Promise<unknown>((resolve, reject) => {
            const pending: PendingRpc = { resolve, reject };
            if (timeoutMs > 0) {
                pending.timer = setTimeout(() => {
                    if (this.pendingRpcs.delete(id)) {
                        reject(new Error(`ACP 请求 ${method} 超时（>${timeoutMs}ms）`));
                    }
                }, timeoutMs);
                pending.timer.unref?.();
            }
            this.pendingRpcs.set(id, pending);

            child.stdin.write(formatJsonRpcMessage({ id, method, params }), "utf8", (error) => {
                if (error && this.pendingRpcs.delete(id)) {
                    if (pending.timer) clearTimeout(pending.timer);
                    reject(new Error(`写入 ACP 输入流失败：${error.message}`));
                }
            });
        });
    }

    private rejectAllPending(error: Error): void {
        for (const [id, pending] of this.pendingRpcs.entries()) {
            this.pendingRpcs.delete(id);
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(error);
        }
    }

    private collectToolSteps(turn: ActiveTurn): AgyToolStepSummary[] {
        return turn.toolOrder
            .map((id) => turn.toolMap.get(id))
            .filter((item): item is AgyToolStepSummary & { startedAt: number } => item !== undefined)
            .map(({ startedAt: _startedAt, ...step }) => step);
    }

    private emitProgress(turn: ActiveTurn): void {
        turn.callbacks.onProgress?.({
            command: this.config.command,
            conversationId: this.conversationId,
            phase: turn.phase,
            activeTool: turn.activeTool,
            toolSteps: this.collectToolSteps(turn),
            streamedText: turn.streamedText,
            startedAt: turn.startedAt,
        });
    }

    private async closeProcessGracefully(): Promise<void> {
        const child = this.proc;
        if (!child) return;

        if (child.exitCode !== null) {
            this.proc = undefined;
            this.sessionReady = false;
            return;
        }

        const waiter = this.closeWaiter ?? new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.once("error", () => resolve());
        });

        try {
            if (!child.stdin.destroyed) {
                child.stdin.end();
            }
        } catch {
            // 忽略已关闭的 stdin 错误。
        }

        const exitedCleanly = await Promise.race([
            waiter.then(() => true),
            new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), this.gracefulCloseTimeoutMs);
                timer.unref?.();
            }),
        ]);

        if (!exitedCleanly && child.exitCode === null) {
            sendSignalToProcessGroup(child, "SIGTERM");
            const exitedAfterTerm = await Promise.race([
                waiter.then(() => true),
                new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => resolve(false), 1500);
                    timer.unref?.();
                }),
            ]);
            if (!exitedAfterTerm && child.exitCode === null) {
                sendSignalToProcessGroup(child, "SIGKILL");
                await Promise.race([
                    waiter,
                    new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, 1000);
                        timer.unref?.();
                    }),
                ]);
            }
        }

        if (this.proc === child) {
            this.proc = undefined;
            this.sessionReady = false;
        }
    }
}

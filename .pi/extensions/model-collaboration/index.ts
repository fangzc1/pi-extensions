import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { createProvider, getSupportedThinkingLevels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
    createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, truncateHead,
    type ExtensionAPI, type ExtensionContext, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { Collaboration, ConfigStore, modelKey, resolveModel, toolsForAccess, type Config, type Level } from "./core.ts";
import { ModelPanel } from "./model-panel.ts";
import { ExecutionProgress } from "./progress.ts";
import { RequestDiagnostics } from "./diagnostics.ts";

const runtime = globalThis as typeof globalThis & { __piCollaborationOwner?: symbol };

export default function modelCollaboration(pi: ExtensionAPI): void {
    if (runtime.__piCollaborationOwner) return;
    const owner = Symbol("model-collaboration");
    runtime.__piCollaborationOwner = owner;
    const store = new ConfigStore(join(getAgentDir(), "subagent-models.json"));
    let context: ExtensionContext;
    let progress: ((event: AgentSessionEvent) => void) | undefined;
    let diagnostics: RequestDiagnostics | undefined;
    const collaboration = new Collaboration(async (request) => {
        const ctx = context;
        const models = available(ctx);
        const model = resolveModel(models, request.model);
        // 不加载扩展，避免递归委派、UI 副作用和全局模型偏好写入；保留项目规则与 skills。
        // 沿用主会话的重试策略；未配置时使用 SDK 默认值，不再把暂时断线直接当成任务失败。
        const settingsManager = SettingsManager.inMemory({ retry: pi.getSettings().retry, compaction: { enabled: true } });
        const loader = new DefaultResourceLoader({
            cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager,
            noExtensions: true, noPromptTemplates: true, noThemes: true,
            appendSystemPrompt: ["你是受委派的协作模型。只执行提供的任务，不自行扩展范围。遵守项目规则。不得自行委派其他模型。不得自动提交或回滚。最终说明结论、证据、修改文件和验证结果；没有运行验证必须明确说明。"],
        });
        await loader.reload();
        // 独立运行时通过桥接 provider 复用主 registry，不复制或持久化认证信息。
        const modelRuntime = await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
        });
        modelRuntime.registerNativeProvider(createProvider({
            id: model.provider, models: [model],
            auth: { apiKey: { name: "主会话认证", resolve: () => ctx.modelRegistry.getProviderAuth(model.provider) } },
            api: {
                stream: (selected, messages, options) => {
                    const { apiKey: _key, ...rest } = options ?? {};
                    const start = (options: typeof rest) => ctx.modelRegistry.stream(selected, messages, options);
                    return diagnostics ? diagnostics.observe(selected, rest, start) : start(rest);
                },
                streamSimple: (selected, messages, options) => {
                    // OAuth 令牌不能作为显式 API key 再传入，最终认证始终由主 registry 解析。
                    const { apiKey: _key, ...rest } = options ?? {};
                    const start = (options: typeof rest) => ctx.modelRegistry.streamSimple(selected, messages, options);
                    return diagnostics ? diagnostics.observe(selected, rest, start) : start(rest);
                },
            },
        }));
        const { session } = await createAgentSession({
            cwd: ctx.cwd, model, modelRuntime, thinkingLevel: request.level, resourceLoader: loader, settingsManager,
            sessionManager: SessionManager.inMemory(ctx.cwd), tools: toolsForAccess(request.access),
        });
        session.subscribe((event) => progress?.(event));
        return {
            async prompt(text, signal) {
                const abort = () => { void session.abort(); };
                signal?.addEventListener("abort", abort, { once: true });
                try {
                    signal?.throwIfAborted();
                    const start = session.messages.length;
                    await session.prompt(text);
                    const messages = session.messages.slice(start);
                    const last = messages.filter((message) => message.role === "assistant").at(-1);
                    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
                        throw new Error(last.errorMessage ?? `子模型停止：${last.stopReason}`);
                    }
                    const answer = session.getLastAssistantText();
                    if (!answer) throw new Error("子模型没有返回文本结论");
                    return answer;
                } finally { signal?.removeEventListener("abort", abort); }
            },
            dispose() { session.dispose(); },
        };
    });

    function available(ctx: ExtensionContext) {
        return ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
    }

    pi.registerCommand("subagent-models", {
        description: "配置 scoped 模型的子任务思考等级与默认模型",
        async handler(_args, ctx) {
            if (ctx.mode !== "tui") throw new Error("请在终端交互模式中使用 /subagent-models");
            try {
                const models = available(ctx);
                if (!models.length) { ctx.ui.notify("当前没有可用模型", "warning"); return; }
                const config = store.read();
                const result = await ctx.ui.custom<Config | undefined>((tui, theme, _keys, done) => new ModelPanel({
                    models: models.map((model) => {
                        const key = modelKey(model);
                        const supported = getSupportedThinkingLevels(model);
                        const scopedLevel = ctx.scopedModels.find((entry) => modelKey(entry.model) === key)?.thinkingLevel;
                        return {
                            key, levels: supported,
                            effectiveLevel: scopedLevel ?? (supported.includes("medium") ? "medium" : supported[0]),
                        };
                    }),
                    config, theme, done, requestRender: () => tui.requestRender(), height: () => tui.terminal.rows,
                }), { blocked: { kind: "question", message: "配置子模型" } });
                if (result) {
                    store.update((state) => {
                        state.defaultModel = result.defaultModel;
                        Object.assign(state.levels, result.levels);
                    });
                    ctx.ui.notify("子模型配置已保存", "info");
                }
            } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
        },
    });

    pi.on("before_agent_start", async (event, ctx) => {
        let configuration: string;
        try { configuration = JSON.stringify(store.read()); }
        catch { configuration = "配置损坏，请用户运行 /subagent-models 检查"; }
        return { systemPrompt: `${event.systemPrompt}\n\n多模型协作：当用户要求其他模型讨论、实施或评审时，调用 subagent，不要只模拟其他模型的回答。由你整理任务、必要背景、约束和验收标准。用户未指定模型时省略 model，交给默认配置解析；明确指定时原样传递，不擅自替换。只读任务 access=read；只有用户明确授权实施或运行命令时才使用 write。收到结果后由你回应或评审，实际检查实施产生的文件与验证证据。追问同一任务时复用 threadId 并保持模型、权限和等级不变；不得自行无限讨论。\n可用模型：${available(ctx).map(modelKey).join(", ")}\n子模型配置：${configuration}` };
    });

    pi.registerTool({
        name: "subagent", label: "模型协作", executionMode: "sequential",
        description: "委派另一模型讨论、评审或实施；可通过 threadId 继续交流。结果最多 50KB/2000 行，超出部分保存临时文件。write 可修改项目并运行命令，取消不回滚。",
        parameters: Type.Object({
            model: Type.Optional(Type.String({ description: "用户指定的完整模型名、唯一 model id 或唯一 provider 简称（如 deepseek）；未指定时省略" })),
            threadId: Type.Optional(Type.String()),
            task: Type.String({ minLength: 1, description: "任务、约束与验收标准" }),
            context: Type.Optional(Type.String({ description: "必要背景、方案、观点和文件路径，不复制完整会话" })),
            access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
        }),
        async execute(_id, params, signal, onUpdate, ctx) {
            const details: Record<string, unknown> = {};
            const timeline = new ExecutionProgress();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let header = "正在准备子模型";
            const update = () => {
                details.progressLines = timeline.lines(true);
                details.progress = timeline.snapshot();
                onUpdate?.({ content: [{ type: "text", text: `${header}\n${timeline.lines().join("\n") || "正在等待模型响应…"}` }], details: { ...details } });
            };
            try {
                const config = store.read();
                const thread = params.threadId ? collaboration.describe(params.threadId) : undefined;
                const model = resolveModel(available(ctx), params.model ?? thread?.model, config.defaultModel, ctx.model && modelKey(ctx.model));
                const key = modelKey(model);
                const supported = getSupportedThinkingLevels(model);
                const scopedLevel = ctx.scopedModels.find((entry) => modelKey(entry.model) === key)?.thinkingLevel;
                const level = thread?.level ?? config.levels[key] ?? scopedLevel ?? (supported.includes("medium") ? "medium" : supported[0]);
                if (!supported.includes(level)) throw new Error(`模型不支持 ${level}，请通过 /subagent-models 重新设置`);
                Object.assign(details, { model: key, level, access: params.access });
                if (params.access === "write") {
                    if (!ctx.hasUI) throw new Error("实施任务需要交互确认，请在交互模式中调用");
                    if (!await ctx.ui.confirm("允许子模型实施？", `${key} 可修改当前项目并执行命令。取消或失败不会回滚。\n${params.task}`)) {
                        throw new Error("用户取消了实施授权");
                    }
                }
                const sessionId = ctx.sessionManager.getSessionId();
                if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("会话标识无效，无法创建诊断记录");
                diagnostics = new RequestDiagnostics(join(getAgentDir(), "model-collaboration-diagnostics", `${sessionId}.jsonl`));
                diagnostics.event("task_start");
                details.diagnosticsPath = diagnostics.path;
                context = ctx;
                header = `${key} · ${level} · ${params.access === "read" ? "只读" : "可实施"}`;
                update();
                progress = (event) => {
                    if (event.type === "auto_retry_start") diagnostics?.event("retry_start", { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs });
                    if (event.type === "auto_retry_end") diagnostics?.event("retry_end", { attempt: event.attempt, success: event.success });
                    if (!timeline.accept(event)) return;
                    if (event.type === "message_update") {
                        // 文本增量合并刷新；定时补发末次增量，避免节流吞掉最后一段。
                        timer ??= setTimeout(() => { timer = undefined; update(); }, 100);
                    } else {
                        if (timer) clearTimeout(timer);
                        timer = undefined;
                        update();
                    }
                };
                const result = await collaboration.run({
                    model: key, level, access: params.access, threadId: params.threadId,
                    task: params.context ? `${params.task}\n\n背景材料：\n${params.context}` : params.task,
                }, signal);
                timeline.finish();
                Object.assign(details, { threadId: result.threadId, progressLines: timeline.lines(true), progress: timeline.snapshot(), status: "已完成" });
                const truncated = truncateHead(result.text);
                let output = truncated.content;
                if (truncated.truncated) {
                    const path = join(mkdtempSync(join(tmpdir(), "pi-subagent-")), "result.txt");
                    writeFileSync(path, result.text, { mode: 0o600 });
                    output += `\n[结果已截断；完整内容：${path}]`;
                    details.fullOutputPath = path;
                }
                return { content: [{ type: "text" as const, text: `${key} · ${level} · ${params.access}\nthreadId: ${result.threadId}\n\n${output}` }], details };
            } catch (error) {
                timeline.finish(signal?.aborted);
                Object.assign(details, { progressLines: timeline.lines(true), progress: timeline.snapshot(), status: signal?.aborted ? "已取消" : "失败" });
                return { isError: true, content: [{ type: "text" as const, text: `${error instanceof Error ? error.message : String(error)}\n${params.access === "write" ? "若已开始实施，文件修改可能保留，请检查工作区。" : "本次为只读任务，未授予文件写入和命令执行权限。"}` }], details };
            } finally {
                diagnostics?.event("task_end", { success: details.status === "已完成", cancelled: signal?.aborted ?? false });
                if (diagnostics?.failed) details.diagnosticsWarning = "诊断写入失败，记录可能不完整";
                diagnostics = undefined;
                if (timer) clearTimeout(timer);
                progress = undefined;
            }
        },
        renderCall(args, theme) {
            const task = typeof args.task === "string" ? args.task.replace(/\s+/g, " ") : "";
            return new Text(`${theme.fg("toolTitle", "模型协作")} · ${args.model ?? "默认模型"}\n${task}`, 0, 0);
        },
        renderResult(result, { expanded, isPartial }, theme) {
            const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
            const details = result.details as Record<string, unknown> | undefined;
            if (isPartial) {
                const lines = expanded && Array.isArray(details?.progressLines)
                    ? [text.split("\n")[0], ...details.progressLines] : text.split("\n");
                return new Text(lines.map((line) => theme.fg(line.startsWith("✗") ? "error" : line.startsWith("✓") ? "success" : "muted", line)).join("\n"), 0, 0);
            }
            const status = String(details?.status ?? "结束");
            const history = expanded && Array.isArray(details?.progressLines) ? details.progressLines.join("\n") + "\n\n" : "";
            const summary = expanded ? text : text.split("\n").filter((line) => !line.startsWith("threadId:")).slice(0, 7).join("\n");
            const fullPath = !expanded && details?.fullOutputPath ? `\n完整结果：${details.fullOutputPath}` : "";
            const diagnosticNote = status !== "已完成" && details?.diagnosticsPath ? `\n脱敏诊断：${details.diagnosticsPath}` : "";
            const warning = details?.diagnosticsWarning ? `\n${details.diagnosticsWarning}` : "";
            return new Text(`${theme.fg(status === "已完成" ? "success" : "error", status)}\n${history}${summary}${fullPath}${diagnosticNote}${warning}`, 0, 0);
        },
    });
    // 切换/分支时丢弃线程，防止把旧分支的隐含上下文带到新分支。
    pi.on("session_start", async () => { await collaboration.clear(); });
    pi.on("session_tree", async () => { await collaboration.clear(); });
    pi.on("session_shutdown", async () => {
        await collaboration.clear();
        if (runtime.__piCollaborationOwner === owner) runtime.__piCollaborationOwner = undefined;
    });
}

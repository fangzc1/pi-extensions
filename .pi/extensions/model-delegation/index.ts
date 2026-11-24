import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { createProvider, getSupportedThinkingLevels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
    createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, truncateHead,
    type ExtensionAPI, type ExtensionContext, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { Collaboration, ConfigStore, modelKey, resolveModel, toolsForAccess, type Config, type Level } from "./core.ts";
import { ModelPanel } from "./model-panel.ts";
import { ExecutionProgress } from "./progress.ts";
import { RequestDiagnostics } from "./diagnostics.ts";
import { CollaborationInset, PreviewText, ProgressText } from "./rendering.ts";

interface RunObserver {
    ctx: ExtensionContext;
    progress: (event: AgentSessionEvent) => void;
    diagnostics: RequestDiagnostics;
}

const runtime = globalThis as typeof globalThis & { __piCollaborationOwner?: symbol };

export default function modelCollaboration(pi: ExtensionAPI): void {
    if (runtime.__piCollaborationOwner) return;
    const owner = Symbol("model-delegation");
    runtime.__piCollaborationOwner = owner;
    const store = new ConfigStore(join(getAgentDir(), "subagent-models.json"));
    const collaboration = new Collaboration<RunObserver>(async (request, initial) => {
        const ctx = initial!.ctx;
        let observer: RunObserver | undefined;
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
                    return observer ? observer.diagnostics.observe(selected, rest, start) : start(rest);
                },
                streamSimple: (selected, messages, options) => {
                    // OAuth 令牌不能作为显式 API key 再传入，最终认证始终由主 registry 解析。
                    const { apiKey: _key, ...rest } = options ?? {};
                    const start = (options: typeof rest) => ctx.modelRegistry.streamSimple(selected, messages, options);
                    return observer ? observer.diagnostics.observe(selected, rest, start) : start(rest);
                },
            },
        }));
        const { session } = await createAgentSession({
            cwd: ctx.cwd, model, modelRuntime, thinkingLevel: request.level, resourceLoader: loader, settingsManager,
            sessionManager: SessionManager.inMemory(ctx.cwd), tools: toolsForAccess(request.access),
        });
        session.subscribe((event) => observer?.progress(event));
        return {
            async prompt(text, signal, current) {
                // 缓存会话续聊时必须绑定当前轮观察者，而不是首轮闭包。
                observer = current;
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
                } finally {
                    signal?.removeEventListener("abort", abort);
                    observer = undefined;
                }
            },
            dispose() { session.dispose(); },
        };
    });

    function available(ctx: ExtensionContext) {
        return ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
    }

    pi.registerCommand("model-delegation-config", {
        description: "配置 scoped 模型的子任务思考等级与默认模型",
        async handler(_args, ctx) {
            if (ctx.mode !== "tui") throw new Error("请在终端交互模式中使用 /model-delegation-config");
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
        catch { configuration = "配置损坏，请用户运行 /model-delegation-config 检查"; }
        return { systemPrompt: `${event.systemPrompt}\n\n模型委派：仅当用户明确要求其他模型或子模型参与时，才允许调用 delegate_to_model，不要只模拟其他模型的回答。普通的“实施、继续、修改、检查、评审”等指令仅授权主会话执行，不构成模型委派授权；不得因任务复杂、适合并行或已配置默认模型而自行委派。用户明确禁止委派时，由主会话自行执行。由你整理任务、必要背景、约束和验收标准。用户明确委派但未指定模型时省略 model，交给默认配置解析；明确指定时原样传递，不擅自替换。只读任务 access=read；只有在已有明确委派授权且用户明确授权实施或运行命令时才使用 write，子模型写权限确认不能替代委派授权。收到结果后由你回应或评审，实际检查实施产生的文件与验证证据。追问同一任务时复用 threadId 并保持模型、权限和等级不变；不得自行无限讨论。独立的只读委派应通过 codemode 的 Promise.allSettled 同时发起；同一 threadId 不可并发，write 与本扩展所有子任务互斥，冲突直接拒绝而不排队。\n可用模型：${available(ctx).map(modelKey).join(", ")}\n子模型配置：${configuration}` };
    });

    pi.registerTool({
        name: "delegate_to_model", label: "模型委派", renderShell: "self",
        description: "仅用于用户明确要求其他模型或子模型参与的任务；普通实施、继续、修改、检查或评审指令不构成委派授权，禁止自主委派。委派另一模型讨论、评审或实施，可通过 threadId 继续交流。结果最多 50KB/2000 行，超出部分保存临时文件。write 可修改项目并运行命令，取消不回滚。",
        parameters: Type.Object({
            model: Type.Optional(Type.String({ description: "用户指定的完整模型名、唯一 model id 或唯一 provider 简称（如 deepseek）；未指定时省略" })),
            threadId: Type.Optional(Type.String()),
            task: Type.String({ minLength: 1, description: "任务、约束与验收标准" }),
            context: Type.Optional(Type.String({ description: "必要背景、方案、观点和文件路径，不复制完整会话" })),
            access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
        }),
        async execute(_id, params, signal, onUpdate, ctx) {
            let diagnostics: RequestDiagnostics | undefined;
            const taskId = randomUUID();
            const details: Record<string, unknown> = { taskId };
            const timeline = new ExecutionProgress();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let header = "正在准备子模型";
            const update = () => {
                details.progressLines = timeline.lines(true);
                details.progress = timeline.snapshot();
                details.currentLines = timeline.currentLines();
                onUpdate?.({ content: [{ type: "text", text: `${header}\n${timeline.currentLines().join("\n")}` }], details: { ...details } });
            };
            try {
                const config = store.read();
                const thread = params.threadId ? collaboration.describe(params.threadId) : undefined;
                const model = resolveModel(available(ctx), params.model ?? thread?.model, config.defaultModel, ctx.model && modelKey(ctx.model));
                const key = modelKey(model);
                const supported = getSupportedThinkingLevels(model);
                const scopedLevel = ctx.scopedModels.find((entry) => modelKey(entry.model) === key)?.thinkingLevel;
                const level = thread?.level ?? config.levels[key] ?? scopedLevel ?? (supported.includes("medium") ? "medium" : supported[0]);
                if (!supported.includes(level)) throw new Error(`模型不支持 ${level}，请通过 /model-delegation-config 重新设置`);
                Object.assign(details, { model: key, level, access: params.access });
                const sessionId = ctx.sessionManager.getSessionId();
                if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("会话标识无效，无法创建诊断记录");
                diagnostics = new RequestDiagnostics(join(getAgentDir(), "model-collaboration-diagnostics", `${sessionId}.jsonl`), undefined, taskId);
                diagnostics.event("task_start");
                details.diagnosticsPath = diagnostics.path;
                header = `${key} · ${level} · ${params.access === "read" ? "只读" : "可实施"}`;
                update();
                const progress = (event: AgentSessionEvent) => {
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
                }, signal, { ctx, progress, diagnostics }, async (taskSignal) => {
                    // 确认也占用写权限，避免并发弹窗和确认后交错运行。
                    if (params.access !== "write") return;
                    if (!ctx.hasUI) throw new Error("实施任务需要交互确认，请在交互模式中调用");
                    if (!await ctx.ui.confirm("允许子模型实施？", `${key} 可修改当前项目并执行命令。取消或失败不会回滚。\n${params.task}`, { signal: taskSignal })) {
                        throw new Error("用户取消了实施授权");
                    }
                });
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
            }
        },
        renderCall(args, theme, context) {
            const task = typeof args.task === "string" ? args.task : "模型委派";
            const title = task.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
            const state = context.state ?? {};
            // 标题顶格，仅下方主题与结果内容缩进。
            return {
                invalidate() {},
                render(width: number) {
                    const status = state.collaborationStatus;
                    const color = status === "已完成" ? "success" : status === "失败" || context.isError ? "error" : status === "已取消" ? "muted" : "toolTitle";
                    const metadata = state.collaborationMetadata ?? `${typeof args.model === "string" ? args.model : "默认模型"} · ${args.access === "write" ? "可实施" : "只读"}`;
                    // 失败圆点沿用 claude-style 的 Bash/Read/Codemode 指示色，状态色不扩散到标题文字。
                    const bullet = color === "error" ? "\u001b[38;5;211m●\u001b[39m" : theme.fg(color, "●");
                    const titleText = `${bullet} ${theme.fg("toolTitle", `model-delegation(${metadata})`)}`;
                    const hint = context.expanded ? "" : context.keyHint?.("app.tools.expand", "展开详情");
                    // keyHint 的快捷键使用 dim，说明文字沿用同色，不再使用独立的 muted 色。
                    const hintText = hint ? theme.fg("dim", hint.replace(/\x1b\[[0-9;]*m/g, "")) : "";
                    // 提示固定留在标题末尾，先为快捷键预留宽度，再截断模型元信息。
                    const heading = hintText
                        ? [visibleWidth(hintText) >= width ? truncateToWidth(hintText, width)
                            : `${truncateToWidth(titleText, width - visibleWidth(hintText) - 1)} ${hintText}`]
                        : new ProgressText(titleText).render(width);
                    const subject = theme.fg("muted", `  ${context.expanded ? task : title || "模型委派"}`);
                    return [...heading, ...(context.expanded
                        ? new Text(subject, 0, 0).render(width)
                        : new ProgressText(subject).render(width))];
                },
            };
        },
        renderResult(result, { expanded, isPartial }, theme, context) {
            const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
            const details = result.details as Record<string, unknown> | undefined;
            const status = isPartial ? "执行中" : String(details?.status ?? (result.isError ? "失败" : "结束"));
            if (context.state) context.state.collaborationStatus = status;
            const metadata = [details?.model, details?.level, details?.access === "write" ? "可实施" : details?.access === "read" ? "只读" : undefined].filter(Boolean).join(" · ");
            // 模型元信息交给调用区标题展示，结果区不再重复占行。
            if (context.state && metadata) context.state.collaborationMetadata = metadata;
            const progress = details?.progress as { finishedTools?: number; items?: { state?: string }[] } | undefined;
            if (isPartial) {
                const current: string[] = Array.isArray(details?.currentLines) ? details.currentLines : text.split("\n").slice(1);
                const running = current.filter((line) => line.startsWith("● "));
                const phase = current[0]?.replace(/^当前：/, "").split(" · ")[0] || "等待模型响应";
                const lines = [theme.fg("accent", `⎿ ${running.length ? running[0].slice(2) : phase}`)];
                const runningCount = progress?.items?.filter((item) => item.state === "running").length ?? running.length;
                if (runningCount > 1) lines.push(theme.fg("muted", `  另有 ${runningCount - 1} 项工具正在执行`));
                const latestText = current.find((line) => line.startsWith("最近说明："));
                if (!runningCount && latestText) lines.push(theme.fg("muted", `  ${latestText}`));
                if (progress?.finishedTools !== undefined) lines.push(theme.fg("muted", `  已完成 ${progress.finishedTools} 次工具调用`));
                if (expanded && Array.isArray(details?.progressLines)) lines.push("\n执行过程", ...details.progressLines);
                const output = lines.join("\n");
                return new CollaborationInset(expanded ? new Text(output, 0, 0) : new ProgressText(output));
            }
            const history = expanded && Array.isArray(details?.progressLines) ? "执行过程\n" + details.progressLines.join("\n") + "\n\n" : "";
            // 模型元数据单独展示，正文不重复协议头；兼容没有元数据的失败结果。
            const body = details?.status === "已完成" ? text.split("\n").slice(3).join("\n") : text;
            const preview = new PreviewText(body, expanded ? Infinity : 2);
            const fullPath = !expanded && details?.fullOutputPath ? `\n完整结果：${details.fullOutputPath}` : "";
            const diagnosticNote = status !== "已完成" && details?.diagnosticsPath ? `\n脱敏诊断：${details.diagnosticsPath}` : "";
            const warning = details?.diagnosticsWarning ? `\n${details.diagnosticsWarning}` : "";
            const heading = theme.fg(status === "已完成" ? "success" : "muted", `⎿ ${status}${progress?.finishedTools !== undefined ? ` · ${progress.finishedTools} 次工具调用` : ""}`);
            const footer = `${expanded && details?.threadId ? `\n线程：${details.threadId}` : ""}${fullPath}${diagnosticNote}${warning}`;
            return new CollaborationInset({
                invalidate() { preview.invalidate(); },
                render(width: number) {
                    return [...new ProgressText(heading).render(width),
                        ...(history ? new Text(history, 0, 0).render(width) : []),
                        ...(expanded ? new Text("结果", 0, 0).render(width) : []), ...preview.render(width),
                        ...(footer ? new Text(footer, 0, 0).render(width) : [])];
                },
            });
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

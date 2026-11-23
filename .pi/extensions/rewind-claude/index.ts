import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CustomEditor,
    sessionEntryToContextMessages,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
    CheckpointStore,
    FileRestorer,
    ToolChangeTracker,
    type Checkpoint,
    type RestoreChange,
} from "./core.ts";
import { DoubleEscapeEditor } from "./double-escape-editor.ts";
import { restorePreservedForkRuntime, withPreservedForkRuntime } from "./fork-model.ts";
import {
    buildActionOptions,
    buildPromptHistoryBefore,
    chooseRewindAction,
    findUserEntryForMessage,
    getUserPromptText,
    selectActiveCheckpoints,
    shouldForkConversation,
    type RewindAction,
} from "./interaction.ts";
import {
    RewindConfirmationMenu,
    RewindPointMenu,
    type RewindMenuItem,
    type RewindMenuResult,
    type RewindPointItem,
} from "./menu.ts";

interface PendingCompaction {
    targetEntryId: string;
    customInstructions?: string;
}

const runtimeState = globalThis as typeof globalThis & {
    __piTimerRewindClaudeOwner?: symbol;
    __piTimerRewindClaudePromptHistory?: string[];
};

function acquireRegistration(): (() => void) | undefined {
    if (runtimeState.__piTimerRewindClaudeOwner) return undefined;
    const owner = Symbol("pi-timer:rewind-claude");
    runtimeState.__piTimerRewindClaudeOwner = owner;
    return () => {
        if (runtimeState.__piTimerRewindClaudeOwner === owner) {
            runtimeState.__piTimerRewindClaudeOwner = undefined;
        }
    };
}

function getToolPath(event: { toolName: string; input: unknown }): string | undefined {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    if (!event.input || typeof event.input !== "object") return undefined;
    const input = event.input as { path?: unknown; file_path?: unknown };
    const path = input.path ?? input.file_path;
    return typeof path === "string" && path.length > 0 ? path : undefined;
}

function getStoreRoot(ctx: ExtensionContext): string {
    const sessionFile = ctx.sessionManager.getSessionFile();
    return sessionFile
        ? `${sessionFile}.rewind-claude`
        : join(tmpdir(), "pi-rewind-claude", ctx.sessionManager.getSessionId());
}

function notifyCheckpointWarning(ctx: ExtensionContext, message: string): void {
    try {
        ctx.ui.notify(message, "warning");
    } catch {
        // Rewind 告警自身也不得阻断原始工具调用。
    }
}

async function pickPoint(
    ctx: ExtensionCommandContext,
    items: Array<RewindPointItem<string>>,
    initialValue?: string,
): Promise<RewindMenuResult<string> | null> {
    if (ctx.mode !== "tui") return null;
    return (
        (await ctx.ui.custom<RewindMenuResult<string> | null>((tui, theme, _keybindings, done) =>
            new RewindPointMenu({
                items,
                initialValue,
                theme,
                onDone: done,
                requestRender: () => tui.requestRender(),
            }),
        )) ?? null
    );
}

async function pickAction(
    ctx: ExtensionCommandContext,
    checkpoint: Checkpoint,
    changes: RestoreChange[],
    items: Array<RewindMenuItem<RewindAction>>,
): Promise<RewindMenuResult<RewindAction> | null> {
    if (ctx.mode !== "tui") return null;
    return (
        (await ctx.ui.custom<RewindMenuResult<RewindAction> | null>((tui, theme, _keybindings, done) =>
            new RewindConfirmationMenu({
                prompt: checkpoint.promptPreview,
                createdAt: checkpoint.createdAt,
                changes,
                items,
                theme,
                onDone: done,
                requestRender: () => tui.requestRender(),
            }),
        )) ?? null
    );
}

function summaryMessages(entries: SessionEntry[], targetEntryId: string) {
    const targetIndex = entries.findIndex((entry) => entry.id === targetEntryId);
    if (targetIndex < 0) throw new Error("The selected rewind point is not on the active branch");
    return entries.slice(0, targetIndex).flatMap(sessionEntryToContextMessages);
}

export default function rewindClaude(pi: ExtensionAPI): void {
    const releaseRegistration = acquireRegistration();
    if (!releaseRegistration) return;
    const promptHistory = runtimeState.__piTimerRewindClaudePromptHistory ??= [];

    pi.on("session_shutdown", async () => releaseRegistration());

    let store: CheckpointStore | undefined;
    let toolChangeTracker: ToolChangeTracker | undefined;
    let activeCheckpointId: string | undefined;
    let opening = false;
    let pendingCompaction: PendingCompaction | undefined;
    let pendingUserMessage: unknown;

    async function bindPendingUserEntry(ctx: ExtensionContext): Promise<void> {
        if (!store || !activeCheckpointId || !pendingUserMessage) return;
        const userEntry = findUserEntryForMessage(ctx.sessionManager.getBranch(), pendingUserMessage);
        if (!userEntry) return;
        await store.bindUserEntry(activeCheckpointId, userEntry.id);
        pendingUserMessage = undefined;
    }

    pi.on("session_start", async (event, ctx) => {
        if (event.reason === "fork") {
            try {
                await restorePreservedForkRuntime(event.previousSessionFile, {
                    findModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
                    setModel: (model) => pi.setModel(model),
                    setThinkingLevel: (level) => pi.setThinkingLevel(level),
                });
            } catch (error) {
                ctx.ui.notify(`Rewind model restore failed: ${String(error)}`, "error");
            }
        }

        store = new CheckpointStore({
            rootDir: getStoreRoot(ctx),
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            maxCheckpoints: 100,
        });
        try {
            await store.initialize();
            toolChangeTracker = new ToolChangeTracker(store);
            const activeEntryIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
            if (event.reason === "fork" && event.previousSessionFile) {
                await store.inheritFork(`${event.previousSessionFile}.rewind-claude`, activeEntryIds);
            }
            const checkpoints = await store.listCheckpoints();
            activeCheckpointId = [...checkpoints]
                .reverse()
                .find((checkpoint) => activeEntryIds.has(checkpoint.userEntryId))?.id;
        } catch (error) {
            store = undefined;
            toolChangeTracker = undefined;
            ctx.ui.notify(`Rewind checkpoint initialization failed: ${String(error)}`, "error");
        }

        if (ctx.mode === "tui") {
            const previous = ctx.ui.getEditorComponent();
            ctx.ui.setEditorComponent((tui, theme, keybindings) => {
                const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
                return new DoubleEscapeEditor(base, {
                    isIdle: () => ctx.isIdle(),
                    openRewind: () => {
                        pi.sendUserMessage("/rewind-claude", { expandPromptTemplates: true });
                    },
                    promptHistory,
                });
            });
        }
    });

    // 用户消息落盘后、Agent 工具执行前建立逻辑检查点，确保绑定真实 Session entry。
    pi.on("message_end", async (event, ctx) => {
        if (!store) return;
        const prompt = getUserPromptText(event.message);
        if (prompt) {
            const timestamp =
                typeof event.message.timestamp === "number" ? event.message.timestamp : Date.now();
            const checkpoint = await store.createCheckpoint(`pending:${timestamp}`, prompt);
            activeCheckpointId = checkpoint.id;
            pendingUserMessage = event.message;
            return;
        }
        await bindPendingUserEntry(ctx);
    });

    pi.on("tool_call", async (event, ctx) => {
        try {
            await bindPendingUserEntry(ctx);
        } catch (error) {
            notifyCheckpointWarning(ctx, `Rewind checkpoint binding skipped: ${String(error)}`);
        }
        const filePath = getToolPath(event);
        if (!filePath || !store || !activeCheckpointId) return;
        try {
            await store.captureBefore(activeCheckpointId, filePath);
        } catch (error) {
            // 快照是附加能力；失败时告警但必须让原始 write/edit 继续执行。
            notifyCheckpointWarning(
                ctx,
                `Rewind checkpoint skipped for ${filePath}: ${String(error)}`,
            );
            return;
        }
        try {
            await toolChangeTracker?.begin(event.toolCallId, activeCheckpointId, filePath);
        } catch {
            // Turn 统计失败不能阻止已经建立安全快照的文件工具继续执行。
        }
    });

    pi.on("tool_result", async (event) => {
        if (!getToolPath(event) || !toolChangeTracker) return;
        try {
            await toolChangeTracker.complete(event.toolCallId, event.isError);
        } catch {
            // Turn 统计是展示元数据，失败时不得篡改工具结果或中断 Agent。
        }
    });

    // 将手动 compact 的保留边界改为用户所选 entry，实现“Summarize up to here”。
    pi.on("session_before_compact", async (event, ctx) => {
        if (!pendingCompaction) return;
        const request = pendingCompaction;
        const model = ctx.model;
        if (!model) throw new Error("No active model is available for summarization");
        const messages = summaryMessages(event.branchEntries, request.targetEntryId);
        const conversation = messages.length > 0
            ? messages
            : [{ role: "user" as const, content: "There is no earlier conversation to summarize.", timestamp: Date.now() }];
        const focus = request.customInstructions
            ? `\nFocus especially on: ${request.customInstructions}`
            : "";
        const response = await ctx.modelRegistry.complete(
            model,
            {
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `Summarize the supplied conversation so work can continue with all goals, constraints, decisions, progress, modified files, blockers, and next steps preserved.${focus}\n\n<conversation>\n${JSON.stringify(conversation)}\n</conversation>`,
                            },
                        ],
                        timestamp: Date.now(),
                    },
                ],
            },
            { signal: event.signal, maxTokens: 8192, cacheRetention: "none" },
        );
        const summary = response.content
            .filter((item): item is { type: "text"; text: string } => item.type === "text")
            .map((item) => item.text)
            .join("\n")
            .trim();
        if (!summary) throw new Error("Summarization returned empty content");
        return {
            compaction: {
                summary,
                firstKeptEntryId: request.targetEntryId,
                tokensBefore: event.preparation.tokensBefore,
                usage: response.usage,
                details: { rewindClaude: true, direction: "up-to" },
            },
        };
    });

    async function summarizeUpTo(
        checkpoint: Checkpoint,
        instructions: string,
        ctx: ExtensionCommandContext,
    ): Promise<void> {
        pendingCompaction = {
            targetEntryId: checkpoint.userEntryId,
            customInstructions: instructions || undefined,
        };
        try {
            await new Promise<void>((resolve, reject) => {
                ctx.compact({
                    customInstructions: instructions || undefined,
                    onComplete: () => resolve(),
                    onError: reject,
                });
            });
        } finally {
            pendingCompaction = undefined;
        }
    }

    async function executeAction(
        action: RewindAction,
        checkpoint: Checkpoint,
        instructions: string,
        ctx: ExtensionCommandContext,
    ): Promise<void> {
        if (!store) throw new Error("Rewind checkpoint store is unavailable");
        const forkPromptHistory = shouldForkConversation(action)
            ? buildPromptHistoryBefore(ctx.sessionManager.getBranch(), checkpoint.userEntryId)
            : undefined;
        let rollbackCodeRestore: (() => Promise<void>) | undefined;
        // 联合恢复保留安全备份，只有 Conversation Fork 成功后才视为完整提交。
        if (action === "restore-code" || action === "restore-both") {
            const restorer = new FileRestorer(store);
            const transaction = action === "restore-both"
                ? await restorer.restoreWithRollback(checkpoint.id)
                : undefined;
            const result = transaction?.result ?? await restorer.restore(checkpoint.id);
            if (result.failed > 0) {
                throw new Error(`Code restore failed for ${result.failed} file(s); conversation was not changed`);
            }
            rollbackCodeRestore = transaction?.rollback;
            if (action === "restore-code") {
                const suffix = result.skipped > 0 ? `, skipped ${result.skipped}` : "";
                ctx.ui.notify(`Restored ${result.restored} file(s)${suffix}`, result.skipped > 0 ? "warning" : "info");
            }
        }
        if (shouldForkConversation(action)) {
            const model = ctx.model;
            const previousPromptHistory = [...promptHistory];
            // 新 Session 会在 ctx.fork() 内同步创建 Editor，因此必须在调用前完成裁剪。
            promptHistory.splice(0, promptHistory.length, ...forkPromptHistory!);
            const restorePromptHistory = () => {
                promptHistory.splice(0, promptHistory.length, ...previousPromptHistory);
            };
            let forkResult;
            try {
                forkResult = model
                    ? await withPreservedForkRuntime({
                        sourceSessionFile: ctx.sessionManager.getSessionFile(),
                        provider: model.provider,
                        modelId: model.id,
                        thinkingLevel: pi.getThinkingLevel(),
                    }, () => ctx.fork(checkpoint.userEntryId, { position: "before" }))
                    : await ctx.fork(checkpoint.userEntryId, { position: "before" });
            } catch (error) {
                restorePromptHistory();
                if (rollbackCodeRestore) {
                    try {
                        await rollbackCodeRestore();
                    } catch (rollbackError) {
                        throw new Error(`Conversation fork failed and code rollback also failed: ${String(rollbackError)}`, {
                            cause: error,
                        });
                    }
                }
                throw error;
            }
            if (forkResult.cancelled) {
                restorePromptHistory();
                await rollbackCodeRestore?.();
                throw new Error("Conversation fork was cancelled; restored code was rolled back");
            }
            return;
        }
        if (action === "summarize-from") {
            await ctx.navigateTree(checkpoint.userEntryId, {
                summarize: true,
                customInstructions: instructions || undefined,
            });
            return;
        }
        if (action === "summarize-up-to") {
            await summarizeUpTo(checkpoint, instructions, ctx);
        }
    }

    async function openRewind(ctx: ExtensionCommandContext): Promise<void> {
        if (opening) return;
        opening = true;
        try {
            await ctx.waitForIdle();
            if (!store) throw new Error("Rewind checkpoint store is unavailable");
            const checkpoints = selectActiveCheckpoints(
                await store.listCheckpoints(),
                ctx.sessionManager.getBranch(),
            );
            if (checkpoints.length === 0) {
                ctx.ui.notify("No rewind points are available", "warning");
                return;
            }
            const pointItems = await Promise.all(checkpoints.map(async (checkpoint) => ({
                value: checkpoint.id,
                label: checkpoint.promptPreview,
                changes: await store!.listTurnChanges(checkpoint.id),
            })));
            let selectedPointId: string | undefined;
            const selection = await chooseRewindAction(
                async () => {
                    const result = await pickPoint(ctx, pointItems, selectedPointId);
                    selectedPointId = result?.value;
                    return result;
                },
                async (pointResult) => {
                    const checkpoint = checkpoints.find((item) => item.id === pointResult.value);
                    if (!checkpoint) throw new Error("Selected rewind point no longer exists");
                    const changes = await store!.previewRestore(checkpoint.id);
                    return pickAction(ctx, checkpoint, changes, buildActionOptions(changes.length > 0));
                },
            );
            if (!selection) return;
            const checkpoint = checkpoints.find((item) => item.id === selection.point.value);
            if (!checkpoint) throw new Error("Selected rewind point no longer exists");
            await executeAction(selection.action.value, checkpoint, selection.action.context, ctx);
        } catch (error) {
            ctx.ui.notify(`Rewind failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
            opening = false;
        }
    }

    pi.registerCommand("rewind-claude", {
        description: "Restore or summarize code and conversation from a previous prompt",
        handler: async (_args, ctx) => openRewind(ctx),
    });
}

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelThinkingMemoryStore {
    get(modelKey: string): ThinkingLevel | undefined;
    set(modelKey: string, level: ThinkingLevel): void;
    getLastModel(): ModelRef | undefined;
    setLastModel(model: ModelRef): void;
}

export interface ModelRef {
    provider: string;
    id: string;
}

interface ModelThinkingMemoryState {
    levels: Record<string, ThinkingLevel>;
    lastModel?: ModelRef;
}

const LAST_MODEL_KEY = "$lastModel";

const runtimeState = globalThis as typeof globalThis & {
    __piTimerModelThinkingMemoryOwner?: symbol;
};

function acquireRegistration(): (() => void) | undefined {
    if (runtimeState.__piTimerModelThinkingMemoryOwner) return undefined;
    const owner = Symbol("pi-timer:model-thinking-memory");
    runtimeState.__piTimerModelThinkingMemoryOwner = owner;
    return () => {
        if (runtimeState.__piTimerModelThinkingMemoryOwner === owner) {
            runtimeState.__piTimerModelThinkingMemoryOwner = undefined;
        }
    };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelRef(value: unknown): value is ModelRef {
    return isRecord(value)
        && typeof value.provider === "string"
        && value.provider.length > 0
        && typeof value.id === "string"
        && value.id.length > 0;
}

export function getModelKey(model: ModelRef): string {
    return `${model.provider}/${model.id}`;
}

/**
 * 使用独立 JSON 文件保存全局模型偏好。
 * 每次读写都重新读取文件，避免多个 Pi 进程长期持有过期快照。
 */
export class JsonModelThinkingMemoryStore implements ModelThinkingMemoryStore {
    private readonly filePath: string;

    constructor(filePath = join(getAgentDir(), "model-thinking-levels.json")) {
        this.filePath = filePath;
    }

    get(modelKey: string): ThinkingLevel | undefined {
        return this.readState().levels[modelKey];
    }

    set(modelKey: string, level: ThinkingLevel): void {
        const state = this.readState();
        state.levels[modelKey] = level;
        this.writeState(state);
    }

    getLastModel(): ModelRef | undefined {
        return this.readState().lastModel;
    }

    setLastModel(model: ModelRef): void {
        const state = this.readState();
        state.lastModel = model;
        this.writeState(state);
    }

    private readState(): ModelThinkingMemoryState {
        let content: string;
        try {
            content = readFileSync(this.filePath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { levels: {} };
            throw new Error(`读取 ${this.filePath} 失败`, { cause: error });
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            throw new Error(`${this.filePath} 不是合法 JSON`, { cause: error });
        }

        if (!isRecord(parsed)) {
            throw new Error(`${this.filePath} 的顶层结构必须是对象`);
        }

        const state: ModelThinkingMemoryState = { levels: {} };
        for (const [modelKey, value] of Object.entries(parsed)) {
            if (modelKey === LAST_MODEL_KEY) {
                if (isModelRef(value)) state.lastModel = value;
                continue;
            }
            // 保持兼容旧版扁平结构，并忽略手工编辑产生的未知字段值。
            if (isThinkingLevel(value)) state.levels[modelKey] = value;
        }
        return state;
    }

    private writeState(state: ModelThinkingMemoryState): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        const values: Record<string, ThinkingLevel | ModelRef> = { ...state.levels };
        if (state.lastModel) values[LAST_MODEL_KEY] = state.lastModel;

        try {
            writeFileSync(tempPath, `${JSON.stringify(values, null, 2)}\n`, {
                encoding: "utf8",
                mode: 0o600,
            });
            renameSync(tempPath, this.filePath);
        } catch (error) {
            try {
                unlinkSync(tempPath);
            } catch {
                // 临时文件可能尚未创建，清理失败不覆盖原始写入错误。
            }
            throw new Error(`写入 ${this.filePath} 失败`, { cause: error });
        }
    }
}

function notifyStoreError(ctx: ExtensionContext, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`模型偏好记忆失败：${message}`, "warning");
}

export function createModelThinkingMemoryExtension(store: ModelThinkingMemoryStore) {
    // Session replacement 会重建扩展实例，因此 Fork 前模型保存在工厂闭包中跨实例传递。
    let pendingForkModel: ModelRef | undefined;

    return function modelThinkingMemoryExtension(pi: ExtensionAPI): void {
        let activeModelKey: string | undefined;
        let restoringModel = false;

        function restore(model: ModelRef, ctx: ExtensionContext): void {
            const modelKey = getModelKey(model);
            let rememberedLevel: ThinkingLevel | undefined;

            try {
                rememberedLevel = store.get(modelKey);
            } catch (error) {
                notifyStoreError(ctx, error);
                return;
            }

            // 没有历史记录时完全交给 Pi，保留其默认值和模型能力 clamp 行为。
            if (rememberedLevel === undefined || rememberedLevel === pi.getThinkingLevel()) return;
            pi.setThinkingLevel(rememberedLevel);
        }

        pi.on("session_before_fork", async (_event, ctx) => {
            if (!ctx.model) return;
            pendingForkModel = { provider: ctx.model.provider, id: ctx.model.id };
        });

        pi.on("session_start", async (event, ctx) => {
            if (!ctx.model) return;

            let activeModel = ctx.model;
            const hasConversationEntries = ctx.sessionManager.getEntries().some((entry) =>
                entry.type === "message"
                || entry.type === "custom_message"
                || entry.type === "compaction"
                || entry.type === "branch_summary"
            );
            // Pi 会在全新 Session 的 session_start 前写入模型、thinking level 和扩展初始化 entry。
            // 因此不能用 entries.length 判断空会话，只排除真正包含对话内容的已有 Session。
            const isFreshStartup = event.reason === "startup" && !hasConversationEntries;
            if (event.reason === "fork" || event.reason === "new" || isFreshStartup) {
                try {
                    const rememberedModel = event.reason === "fork"
                        ? pendingForkModel
                        : store.getLastModel();
                    if (event.reason === "fork") pendingForkModel = undefined;
                    const availableModel = rememberedModel
                        ? ctx.modelRegistry.find(rememberedModel.provider, rememberedModel.id)
                        : undefined;

                    if (availableModel && getModelKey(availableModel) !== getModelKey(ctx.model)) {
                        // setModel 会同步触发 model_select；标记恢复过程，避免把内部切换当作手动选择。
                        restoringModel = true;
                        if (await pi.setModel(availableModel)) activeModel = availableModel;
                    }
                } catch (error) {
                    notifyStoreError(ctx, error);
                } finally {
                    restoringModel = false;
                }
            }

            activeModelKey = getModelKey(activeModel);
            restore(activeModel, ctx);
        });

        pi.on("model_select", async (event, ctx) => {
            activeModelKey = getModelKey(event.model);

            if (!restoringModel && (event.source === "set" || event.source === "cycle")) {
                try {
                    store.setLastModel(event.model);
                } catch (error) {
                    notifyStoreError(ctx, error);
                }
            }

            restore(event.model, ctx);
        });

        pi.on("thinking_level_select", async (event, ctx) => {
            if (!ctx.model || !isThinkingLevel(event.level)) return;

            const eventModelKey = getModelKey(ctx.model);
            // Pi 切换模型时会先对新模型执行 clamp，再发 model_select。
            // 此时 ctx.model 已是新模型，但 activeModelKey 仍是旧模型，必须忽略该内部变化。
            if (eventModelKey !== activeModelKey) return;

            try {
                store.set(eventModelKey, event.level);
            } catch (error) {
                notifyStoreError(ctx, error);
            }
        });
    };
}

const modelThinkingMemory = createModelThinkingMemoryExtension(new JsonModelThinkingMemoryStore());

export default function guardedModelThinkingMemory(pi: ExtensionAPI): void {
    const releaseRegistration = acquireRegistration();
    if (!releaseRegistration) return;

    pi.on("session_shutdown", async () => releaseRegistration());
    modelThinkingMemory(pi);
}

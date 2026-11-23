import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

/**
 * pi-ai 的 ThinkingLevel 描述模型能支持的档位，不含 "off"；
 * 而 Pi 运行时的思考级别额外包含 "off" 一档，Fork 前后需要原样保留。
 */
export type RuntimeThinkingLevel = ThinkingLevel | "off";

export interface PreservedForkRuntime {
    sourceSessionFile: string | undefined;
    provider: string;
    modelId: string;
    thinkingLevel: RuntimeThinkingLevel;
}

interface PendingForkRuntime extends PreservedForkRuntime {
    token: symbol;
}

interface ForkRuntimeActions {
    findModel(provider: string, modelId: string): Model<any> | undefined;
    setModel(model: Model<any>): Promise<boolean>;
    setThinkingLevel(level: RuntimeThinkingLevel): void;
}

let pendingRuntime: PendingForkRuntime | undefined;

/**
 * Fork 会销毁旧运行时，因此这里只跨生命周期保存可序列化的模型标识，
 * 绝不把旧 ctx、pi 或 Model 实例带入新 Session。
 */
export async function withPreservedForkRuntime<T>(
    runtime: PreservedForkRuntime,
    operation: () => Promise<T>,
): Promise<T> {
    const token = Symbol("rewind-fork-runtime");
    pendingRuntime = { ...runtime, token };
    try {
        return await operation();
    } finally {
        if (pendingRuntime?.token === token) pendingRuntime = undefined;
    }
}

/** 由 Fork 后的新扩展实例调用，使用新运行时自己的模型 API 完成恢复。 */
export async function restorePreservedForkRuntime(
    previousSessionFile: string | undefined,
    actions: ForkRuntimeActions,
): Promise<boolean> {
    const runtime = pendingRuntime;
    if (!runtime || runtime.sourceSessionFile !== previousSessionFile) return false;
    pendingRuntime = undefined;

    const model = actions.findModel(runtime.provider, runtime.modelId);
    if (!model || !(await actions.setModel(model))) return false;
    actions.setThinkingLevel(runtime.thinkingLevel);
    return true;
}

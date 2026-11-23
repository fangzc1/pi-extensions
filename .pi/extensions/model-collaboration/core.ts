import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = typeof levels[number];
export type Access = "read" | "write";
export interface Config { defaultModel?: string; levels: Record<string, Level>; }
export interface ModelRef { provider: string; id: string; }
export const modelKey = (model: ModelRef): string => `${model.provider}/${model.id}`;

export class ConfigStore {
    private readonly path: string;
    constructor(path: string) { this.path = path; }
    read(): Config {
        let text: string;
        try { text = readFileSync(this.path, "utf8"); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { levels: {} };
            throw new Error("读取子模型配置失败", { cause: error });
        }
        let value: unknown;
        try { value = JSON.parse(text); }
        catch (error) { throw new Error("子模型配置不是合法 JSON", { cause: error }); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("子模型配置必须是对象");
        const config = value as Config;
        if (!config.levels || typeof config.levels !== "object" || Array.isArray(config.levels)
            || Object.values(config.levels).some((level) => !levels.includes(level))
            || (config.defaultModel !== undefined && typeof config.defaultModel !== "string")) {
            throw new Error("子模型配置字段无效");
        }
        return config;
    }
    update(change: (config: Config) => void): void {
        // 每次从磁盘读取并原子替换，避免长期缓存覆盖其他会话的配置。
        const config = this.read();
        change(config);
        mkdirSync(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
            renameSync(temporary, this.path);
        } finally {
            try { unlinkSync(temporary); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
    }
}

export function resolveModel<T extends ModelRef>(models: readonly T[], requested?: string, fallback?: string, current?: string): T {
    const target = requested ?? fallback;
    const available = `可用模型：\n${models.map(modelKey).join("\n") || "（无）"}`;
    if (!target) throw new Error(`请通过 /subagent-models 设置默认模型。\n${available}`);
    const exact = models.find((model) => modelKey(model) === target);
    const byId = models.filter((model) => model.id === target);
    // 完整名称与模型 ID 优先；provider 简称仅在当前范围唯一时解析，禁止模糊猜测。
    const matches = exact ? [exact] : byId.length ? byId : models.filter((model) => model.provider === target);
    if (matches.length !== 1) throw new Error(`${matches.length ? "匹配到多个模型，请指定完整名称" : "模型不在当前范围内"}：${target}\n${available}`);
    if (!requested && modelKey(matches[0]) === current) throw new Error(`默认子模型与当前模型相同，请重新选择。\n${available}`);
    return matches[0];
}

export function toolsForAccess(access: Access): string[] {
    return access === "read" ? ["read", "grep", "find", "ls"] : ["read", "grep", "find", "ls", "edit", "write", "bash"];
}
export interface Request { model: string; level: Level; access: Access; task: string; threadId?: string; }
export interface Child {
    prompt(text: string, signal?: AbortSignal): Promise<string>;
    dispose(): void;
}
interface Thread { child: Child; model: string; level: Level; access: Access; }

export class Collaboration {
    private readonly threads = new Map<string, Thread>();
    private active?: AbortController;
    private pending?: Promise<unknown>;
    private readonly create: (request: Request) => Promise<Child>;
    constructor(create: (request: Request) => Promise<Child>) { this.create = create; }
    describe(threadId: string): { model: string; level: Level; access: Access } {
        const thread = this.threads.get(threadId);
        if (!thread) throw new Error("协作线程不存在或已失效，请创建新任务并补充背景");
        return { model: thread.model, level: thread.level, access: thread.access };
    }
    async run(request: Request, signal?: AbortSignal): Promise<{ threadId: string; text: string }> {
        if (this.active) throw new Error("已有子模型正在执行，请等待完成");
        if (signal?.aborted) throw new Error("子任务已取消");
        const controller = new AbortController();
        this.active = controller;
        const cancel = () => controller.abort();
        signal?.addEventListener("abort", cancel, { once: true });
        const operation = async () => {
            const threadId = request.threadId ?? randomUUID();
            let thread = this.threads.get(threadId);
            if (request.threadId && !thread) throw new Error("协作线程不存在或已失效，请创建新任务并补充背景");
            if (thread && (thread.model !== request.model || thread.access !== request.access || thread.level !== request.level)) {
                throw new Error("继续线程时模型、权限和思考等级必须保持一致，请创建新线程");
            }
            if (!thread) {
                const child = await this.create(request);
                thread = { child, model: request.model, level: request.level, access: request.access };
                this.threads.set(threadId, thread);
            }
            if (controller.signal.aborted) throw new Error("子任务已取消");
            const text = await thread.child.prompt(request.task, controller.signal);
            if (controller.signal.aborted) throw new Error("子任务已取消；已产生的文件修改不会自动回滚");
            return { threadId, text };
        };
        this.pending = operation();
        try { return await this.pending as { threadId: string; text: string }; }
        finally {
            signal?.removeEventListener("abort", cancel);
            this.active = undefined;
            this.pending = undefined;
        }
    }
    async clear(): Promise<void> {
        this.active?.abort();
        await this.pending?.catch(() => {});
        for (const thread of this.threads.values()) thread.child.dispose();
        this.threads.clear();
    }
}

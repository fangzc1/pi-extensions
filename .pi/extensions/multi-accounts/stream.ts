import type { Provider, Model, Api, TranscriptContext, StreamOptions, AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AccountStore, fingerprint, type QuotaObservation } from "./store.ts";
import { queryQuota, resetTime } from "./quota.ts";

// 必须同时拿到原始状态与明确错误码；普通 429 的友好文案不能作为依据。
export function isQuotaError(status: number, body: unknown): boolean {
    return status === 429 && typeof body === "object" && body !== null
        && "error" in body && typeof body.error === "object" && body.error !== null
        && (("code" in body.error ? body.error.code : undefined)
            ?? ("type" in body.error ? body.error.type : undefined)) === "usage_limit_reached";
}
async function inspect(response: Response): Promise<{ resetAt?: number } | undefined> {
    if (response.status !== 429 || !response.body) return undefined;
    const reader = response.clone().body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let size = 0;
    const timeout = setTimeout(() => { void reader.cancel().catch(() => {}); }, 2000);
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65536) return undefined;
            body += decoder.decode(chunk.value, { stream: true });
        }
        const parsed = JSON.parse(body + decoder.decode());
        return isQuotaError(response.status, parsed) ? { resetAt: resetTime(parsed.error.resets_at) } : undefined;
    } catch { return undefined; }
    finally { clearTimeout(timeout); void reader.cancel().catch(() => {}); }
}
export function wrapCodex(
    base: Provider,
    store: AccountStore,
    resolve: () => Promise<string | undefined>,
    notify: (message: string) => void,
): Provider {
    function run(model: Model<Api>, context: TranscriptContext, options: StreamOptions | undefined,
        start: (options: StreamOptions) => AssistantMessageEventStream): AssistantMessageEventStream {
        const output = createAssistantMessageEventStream();
        void (async () => {
            let apiKey = options?.apiKey;
            let terminal: AssistantMessage | undefined;
            let stage = "模型请求";
            try {
                let initial;
                try {
                    initial = await store.snapshot(base.id);
                } catch {
                    // 管理元数据不可读不能阻断宿主已准备好的正常认证请求。
                    notify("账号库暂不可读，本次使用原生请求，不执行自动轮换。");
                    for await (const event of start(options ?? {})) output.push(event);
                    output.end();
                    return;
                }
                const safeEndpoint = model.baseUrl.startsWith("https://chatgpt.com/");
                const extraAuth = Object.keys({ ...model.headers, ...options?.headers }).some(key => /^(authorization|chatgpt-account-id)$/i.test(key));
                if (!safeEndpoint || extraAuth || !initial.pool.auto || !initial.pool.active || initial.current?.type !== "oauth" || initial.current.access !== apiKey) {
                    for await (const event of start(options ?? {})) output.push(event);
                    output.end(); return;
                }
                const tried = new Set<string>();
                const limit = initial.pool.accounts.length;
                for (let attempt = 0; attempt < limit; attempt++) {
                    options?.signal?.throwIfAborted();
                    stage = "读取账号状态";
                    const snapshot = await store.snapshot(base.id);
                    const current = snapshot.current;
                    if (!apiKey || current?.type !== "oauth" || current.access !== apiKey || !snapshot.pool.active || tried.has(snapshot.pool.active)) break;
                    tried.add(snapshot.pool.active);
                    let quota: { resetAt?: number } | undefined;
                    let started = false;
                    const fetcher = options?.fetch ?? globalThis.fetch;
                    stage = "模型请求";
                    const stream = start({ ...options, apiKey, transport: "sse", maxRetries: 0,
                        fetch: async (input, init) => {
                            const headers = new Headers(input instanceof Request ? input.headers : undefined);
                            new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
                            const owned = headers.get("authorization") === `Bearer ${apiKey}`;
                            const response = await fetcher(input, init);
                            quota = owned ? await inspect(response) : undefined;
                            return response;
                        },
                    });
                    for await (const event of stream) {
                        if (event.type === "error") {
                            terminal = event.error;
                            if (!started && quota && !options?.signal?.aborted) break;
                            if (options?.signal?.aborted) output.push({ type: "error", reason: "aborted", error: { ...event.error, stopReason: "aborted", errorMessage: "请求已取消。" } });
                            else output.push(event);
                            output.end(); return;
                        }
                        started = true;
                        output.push(event);
                        if (event.type === "done") { output.end(); return; }
                    }
                    if (started || !quota || options?.signal?.aborted) break;
                    stage = "查询备用账号额度";
                    const observations = new Map<string, QuotaObservation>();
                    const activeIndex = snapshot.pool.accounts.findIndex(account => account.id === snapshot.pool.active);
                    // 按轮换顺序查询，包括旧库中曾受限的账号；确认可用前不修改全局登录槽位。
                    for (let n = 1; n < snapshot.pool.accounts.length; n++) {
                        const candidate = snapshot.pool.accounts[(activeIndex + n) % snapshot.pool.accounts.length];
                        if (!candidate.enabled || tried.has(candidate.id)) continue;
                        options?.signal?.throwIfAborted();
                        const state = await queryQuota(candidate.credential, options?.fetch ?? globalThis.fetch, options?.signal);
                        if (!state) continue;
                        observations.set(candidate.id, { credential: fingerprint(candidate.credential), state });
                        if (state.available) break;
                    }
                    options?.signal?.throwIfAborted();
                    stage = "写入轮换账号";
                    const changed = await store.rotate(base.id, fingerprint(current), snapshot.pool.generation, model.id, quota.resetAt, observations);
                    if (changed) notify("Codex 额度已用尽，已确认备用账号额度并全局切换。");
                    else { notify("未找到已确认有额度的备用账号，或账号状态已变化；未自动切换。"); break; }
                    stage = "解析切换后认证";
                    apiKey = await resolve();
                }
                if (terminal) { output.push({ type: "error", reason: terminal.stopReason === "aborted" ? "aborted" : "error", error: terminal }); output.end(); return; }
                stage = "校验当前凭据一致性";
                throw new Error("账号状态已变化，请重新发送请求。");
            } catch {
                const aborted = options?.signal?.aborted;
                const error: AssistantMessage = {
                    role: "assistant", provider: model.provider, model: model.id, api: model.api,
                    content: [], timestamp: Date.now(), stopReason: aborted ? "aborted" : "error",
                    // 不回显底层异常，避免 SDK 错误泄露凭据、请求头或响应正文。
                    errorMessage: aborted ? "请求已取消。" : `${stage}阶段失败。请重试；若重复发生，请提供此阶段提示。`,
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                };
                output.push({ type: "error", reason: aborted ? "aborted" : "error", error }); output.end();
            }
        })();
        return output;
    }
    return {
        ...base,
        getModels: base.getModels.bind(base),
        getAllModels: base.getAllModels?.bind(base),
        refreshModels: base.refreshModels?.bind(base),
        filterModels: base.filterModels?.bind(base),
        filterAllModels: base.filterAllModels?.bind(base),
        stream: (model, context, options) => run(model, context, options, next => base.stream(model, context, { ...options, ...next } as typeof options)),
        streamSimple: (model, context, options) => run(model, context, options, next => base.streamSimple(model, context, next)),
    };
}

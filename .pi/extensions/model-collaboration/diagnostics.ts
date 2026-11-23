import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AssistantMessageEventStream, Model, Api, StreamOptions } from "@earendil-works/pi-ai";

/** 仅提取固定错误类别，不把可能包含凭据或正文的原始异常写入诊断。 */
export function errorFacts(error: unknown): { name?: string; codes: string[]; category: string } {
    const codes = new Set<string>();
    let name: string | undefined;
    let category = "unknown";
    const seen = new Set<unknown>();
    for (let current = error, depth = 0; current && depth < 6 && !seen.has(current); depth++) {
        seen.add(current);
        const value = typeof current === "object" ? current as Record<string, unknown> : {};
        if (typeof value.name === "string" && /^(?:Error|TypeError|AbortError|TimeoutError|APIConnectionError|APIError)$/.test(value.name)) name ??= value.name;
        const text = [typeof current === "string" ? current : "", value.message, value.code].filter((item) => typeof item === "string").join(" ");
        for (const code of text.match(/\b(?:UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)\b/g) ?? []) codes.add(code);
        if (/socket|other side closed|terminated|connection|fetch failed/i.test(text)) category = "connection";
        if (/timeout|timed out/i.test(text)) category = "timeout";
        if (/401|403|unauthorized|invalid api key/i.test(text)) category = "authentication";
        if (/abort|cancelled/i.test(text)) category = "cancelled";
        current = value.cause;
    }
    return { name, codes: [...codes], category };
}

export class RequestDiagnostics {
    readonly path: string;
    private writeFailed = false;
    constructor(path: string, privateSink?: (record: Record<string, unknown>) => void) {
        this.path = path;
        this.sink = privateSink ?? ((record) => {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        });
    }
    private readonly sink: (record: Record<string, unknown>) => void;

    get failed(): boolean { return this.writeFailed; }

    event(event: "task_start" | "task_end" | "retry_start" | "retry_end", fields: { attempt?: number; maxAttempts?: number; delayMs?: number; success?: boolean; cancelled?: boolean } = {}): void {
        this.record({ event, ...fields });
    }

    observe<T extends StreamOptions>(model: Model<Api>, options: T, start: (options: T) => AssistantMessageEventStream): AssistantMessageEventStream {
        const requestId = randomUUID();
        const begin = performance.now();
        let firstEventMs: number | undefined;
        let lastEventMs: number | undefined;
        let chunks = 0;
        let status: number | undefined;
        let endpoint: string | undefined;
        try { endpoint = new URL(model.baseUrl).origin; } catch { /* 无效端点交由原请求路径处理。 */ }
        this.record({ event: "request_start", requestId, provider: model.provider, model: model.id, api: model.api, endpoint });
        const wrapped = {
            ...options,
            onResponse: async (response, selected) => {
                status = response.status;
                this.record({ event: "http_response", requestId, status, elapsedMs: Math.round(performance.now() - begin) });
                await options.onResponse?.(response, selected);
            },
            onProviderStreamEvent: async (data, selected) => {
                const now = Math.round(performance.now() - begin);
                chunks++;
                lastEventMs = now;
                if (firstEventMs === undefined) {
                    firstEventMs = now;
                    this.record({ event: "first_stream_event", requestId, elapsedMs: now });
                }
                // 不读取、复制或持久化原始事件内容。
                await options.onProviderStreamEvent?.(data, selected);
            },
        } satisfies StreamOptions;
        const finish = (fields: Record<string, unknown>) => {
            const elapsedMs = Math.round(performance.now() - begin);
            this.record({ event: "request_end", requestId, status, elapsedMs, firstEventMs, lastEventMs, chunks,
                idleSinceLastEventMs: lastEventMs === undefined ? undefined : elapsedMs - lastEventMs, ...fields });
        };
        try {
            const stream = start(wrapped as T);
            // result() 只观察终态，不消费/替换事件流，避免改变 SDK 的重试、取消和背压行为。
            void stream.result().then((message) => {
                finish({ stopReason: message.stopReason, error: message.errorMessage ? errorFacts(message.errorMessage) : undefined });
            }, (error: unknown) => finish({ error: errorFacts(error) }));
            return stream;
        } catch (error) {
            finish({ error: errorFacts(error) });
            throw error;
        }
    }

    private record(fields: Record<string, unknown>): void {
        try { this.sink({ timestamp: new Date().toISOString(), ...fields }); }
        catch { this.writeFailed = true; /* 诊断写入失败不能中断模型任务。 */ }
    }
}

export interface AgyUsage {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
}

export interface JsonRpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}

export type JsonRpcId = string | number;

export type JsonRpcIncoming =
    | {
        kind: "response";
        id: JsonRpcId;
        result?: unknown;
        error?: JsonRpcErrorObject;
    }
    | {
        kind: "request";
        id: JsonRpcId;
        method: string;
        params?: unknown;
    }
    | {
        kind: "notification";
        method: string;
        params?: unknown;
    }
    | {
        kind: "noise";
        line: string;
    };

export interface AcpQuestionOption {
    value: string;
    label: string;
}

export interface AcpElicitationQuestion {
    id: string;
    otherKey?: string;
    title: string;
    description?: string;
    multiSelect: boolean;
    options: AcpQuestionOption[];
}

export interface AcpElicitationRequest {
    sessionId?: string;
    toolCallId?: string;
    message?: string;
    questions: AcpElicitationQuestion[];
}

export type AcpElicitationResult =
    | {
        action: "accept";
        content: Record<string, string | string[]>;
    }
    | {
        action: "decline" | "cancel";
    };

export interface AcpPermissionOption {
    optionId: string;
    name: string;
    kind?: string;
}

export interface AcpPermissionRequest {
    sessionId?: string;
    toolCallId?: string;
    title: string;
    kind?: string;
    rawInput?: Record<string, unknown>;
    options: AcpPermissionOption[];
}

export type AcpPermissionResult =
    | {
        outcome: {
            outcome: "selected";
            optionId: string;
        };
    }
    | {
        outcome: {
            outcome: "cancelled";
        };
    };

export interface AcpConfigOptionValue {
    value: string;
    name: string;
    description?: string;
}

export interface AcpConfigOption {
    id: string;
    name?: string;
    category?: string;
    currentValue?: string;
    options?: AcpConfigOptionValue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 构造单行 JSON-RPC 2.0 报文。 */
export function formatJsonRpcMessage(payload: Record<string, unknown>): string {
    return `${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`;
}

/**
 * 解析单行 stdout 文本。
 * 非 JSON 或不含 jsonrpc/method/id 的杂音行（如 shell 函数中 proxyctl on 输出）归类为 noise，不中断协议流。
 */
export function parseJsonRpcLine(rawLine: string): JsonRpcIncoming | undefined {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) return undefined;

    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return { kind: "noise", line };
    }

    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
        return { kind: "noise", line };
    }

    const hasId = typeof parsed.id === "string" || typeof parsed.id === "number";
    const method = asString(parsed.method);

    if (method && hasId) {
        return {
            kind: "request",
            id: parsed.id as JsonRpcId,
            method,
            params: parsed.params,
        };
    }

    if (method) {
        return {
            kind: "notification",
            method,
            params: parsed.params,
        };
    }

    if (hasId && ("result" in parsed || "error" in parsed)) {
        const error = isRecord(parsed.error)
            ? {
                code: asNumber(parsed.error.code) ?? -32000,
                message: asString(parsed.error.message) ?? "未知 ACP 错误",
                data: parsed.error.data,
            }
            : undefined;
        return {
            kind: "response",
            id: parsed.id as JsonRpcId,
            result: parsed.result,
            error,
        };
    }

    return { kind: "noise", line };
}

/** 带行缓冲的 JSON-RPC NDJSON 解析器，处理任意分片与粘包。 */
export class JsonRpcLineParser {
    private buffer = "";

    push(chunk: string | Buffer): JsonRpcIncoming[] {
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const messages: JsonRpcIncoming[] = [];

        let newlineIndex = this.buffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const rawLine = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            const parsed = parseJsonRpcLine(rawLine);
            if (parsed) messages.push(parsed);
            newlineIndex = this.buffer.indexOf("\n");
        }
        return messages;
    }

    flush(): JsonRpcIncoming[] {
        if (!this.buffer.trim()) {
            this.buffer = "";
            return [];
        }
        const remaining = this.buffer;
        this.buffer = "";
        const parsed = parseJsonRpcLine(remaining);
        return parsed ? [parsed] : [];
    }

    reset(): void {
        this.buffer = "";
    }
}

/** 将 ACP 返回的 camelCase usage 统一归一化为 AgyUsage。 */
export function normalizeAcpUsage(raw: unknown): AgyUsage | undefined {
    if (!isRecord(raw)) return undefined;
    const input = asNumber(raw.inputTokens) ?? asNumber(raw.input_tokens);
    const output = asNumber(raw.outputTokens) ?? asNumber(raw.output_tokens);
    const thinking = asNumber(raw.thoughtTokens) ?? asNumber(raw.thinking_tokens);
    const cacheRead = asNumber(raw.cachedReadTokens) ?? asNumber(raw.cache_read_tokens);
    const total = asNumber(raw.totalTokens) ?? asNumber(raw.total_tokens);
    if (input === undefined && output === undefined && total === undefined) return undefined;
    return {
        input_tokens: input,
        output_tokens: output,
        thinking_tokens: thinking,
        cache_read_tokens: cacheRead,
        total_tokens: total,
    };
}

function extractSchemaOptions(items: unknown): AcpQuestionOption[] {
    if (!Array.isArray(items)) return [];
    const options: AcpQuestionOption[] = [];
    for (const item of items) {
        if (!isRecord(item)) continue;
        const value = asString(item.const);
        if (!value) continue;
        const label = asString(item.title) ?? value;
        options.push({ value, label });
    }
    return options;
}

/**
 * 解析 ACP `elicitation/create` 参数中的问卷 Schema：
 * - 单选：type="string" + oneOf
 * - 多选：type="array" + items.anyOf / items.oneOf
 * - 自由补充：配对键 `<id>_other`
 */
export function parseElicitationRequest(params: unknown): AcpElicitationRequest {
    if (!isRecord(params)) {
        return { questions: [] };
    }
    const requestedSchema = isRecord(params.requestedSchema) ? params.requestedSchema : undefined;
    const properties = requestedSchema && isRecord(requestedSchema.properties)
        ? requestedSchema.properties
        : undefined;

    const questions: AcpElicitationQuestion[] = [];
    if (properties) {
        const keys = Object.keys(properties);
        const keySet = new Set(keys);
        for (const key of keys) {
            if (key.endsWith("_other") && keySet.has(key.slice(0, -"_other".length))) {
                continue;
            }
            const prop = properties[key];
            if (!isRecord(prop)) continue;
            const otherKey = keySet.has(`${key}_other`) ? `${key}_other` : undefined;
            const multiSelect = prop.type === "array";
            let options: AcpQuestionOption[] = [];
            if (multiSelect && isRecord(prop.items)) {
                options = extractSchemaOptions(prop.items.anyOf ?? prop.items.oneOf);
                if (options.length === 0 && Array.isArray(prop.items.enum)) {
                    options = prop.items.enum
                        .filter((v): v is string => typeof v === "string")
                        .map((v) => ({ value: v, label: v }));
                }
            } else {
                options = extractSchemaOptions(prop.oneOf ?? prop.anyOf);
                if (options.length === 0 && Array.isArray(prop.enum)) {
                    options = prop.enum
                        .filter((v): v is string => typeof v === "string")
                        .map((v) => ({ value: v, label: v }));
                }
            }

            questions.push({
                id: key,
                otherKey,
                title: asString(prop.title) ?? asString(prop.description) ?? key,
                description: asString(prop.description),
                multiSelect,
                options,
            });
        }
    }

    return {
        sessionId: asString(params.sessionId),
        toolCallId: asString(params.toolCallId),
        message: asString(params.message),
        questions,
    };
}

/** 解析 ACP `session/request_permission` 请求。 */
export function parsePermissionRequest(params: unknown): AcpPermissionRequest {
    if (!isRecord(params)) {
        return { title: "Antigravity 请求工具权限", options: [] };
    }
    const toolCall = isRecord(params.toolCall) ? params.toolCall : undefined;
    const options: AcpPermissionOption[] = [];
    if (Array.isArray(params.options)) {
        for (const rawOption of params.options) {
            if (!isRecord(rawOption)) continue;
            const optionId = asString(rawOption.optionId);
            if (!optionId) continue;
            options.push({
                optionId,
                name: asString(rawOption.name) ?? optionId,
                kind: asString(rawOption.kind),
            });
        }
    }

    return {
        sessionId: asString(params.sessionId),
        toolCallId: asString(toolCall?.toolCallId),
        title: asString(toolCall?.title) ?? asString(toolCall?.name) ?? "Antigravity 请求执行工具",
        kind: asString(toolCall?.kind),
        rawInput: isRecord(toolCall?.rawInput) ? toolCall.rawInput : undefined,
        options,
    };
}

/** 提取 `session/new` 或 `session/set_config_option` 返回的 configOptions。 */
export function parseAcpConfigOptions(raw: unknown): AcpConfigOption[] {
    if (!Array.isArray(raw)) return [];
    const results: AcpConfigOption[] = [];
    for (const item of raw) {
        if (!isRecord(item)) continue;
        const id = asString(item.id);
        if (!id) continue;
        const options: AcpConfigOptionValue[] = [];
        if (Array.isArray(item.options)) {
            for (const opt of item.options) {
                if (!isRecord(opt)) continue;
                const value = asString(opt.value);
                if (!value) continue;
                options.push({
                    value,
                    name: asString(opt.name) ?? value,
                    description: asString(opt.description),
                });
            }
        }
        results.push({
            id,
            name: asString(item.name),
            category: asString(item.category),
            currentValue: asString(item.currentValue),
            options: options.length > 0 ? options : undefined,
        });
    }
    return results;
}

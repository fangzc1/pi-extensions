import type { Credential } from "@earendil-works/pi-ai";

export interface QuotaState { available: boolean; resetAt?: number; }
function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function resetTime(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && Number.isSafeInteger(value * 1000) ? value * 1000 : undefined;
}
export function parseUsage(body: unknown, now = Date.now()): QuotaState | undefined {
    if (!record(body) || !record(body.rate_limit)) return undefined;
    const rate = body.rate_limit;
    const rawWindows = [rate.primary_window, rate.secondary_window].filter(window => window != null);
    if (rawWindows.some(window => !record(window) || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent) || window.used_percent < 0)) return undefined;
    const windows = rawWindows.filter(record);
    if (typeof rate.allowed !== "boolean" || typeof rate.limit_reached !== "boolean") return undefined;
    const exhausted = windows.filter(window => typeof window.used_percent === "number" && window.used_percent >= 100);
    const available = rate.allowed && !rate.limit_reached && exhausted.length === 0
        && !(record(body.spend_control) && body.spend_control.reached === true);
    const resets = exhausted.map(window => resetTime(window.reset_at)
        ?? (typeof window.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds) && window.reset_after_seconds > 0
            ? now + window.reset_after_seconds * 1000 : undefined));
    // 必须等所有耗尽窗口恢复；缺失任一重置时间时不能宣称已知恢复时刻。
    const resetAt = !available && !(record(body.spend_control) && body.spend_control.reached === true)
        && resets.length > 0 && resets.every(time => time !== undefined)
        ? Math.max(...resets as number[]) : undefined;
    return { available, resetAt };
}
export async function queryQuota(credential: Credential, fetcher: typeof fetch, signal?: AbortSignal): Promise<QuotaState | undefined> {
    if (credential.type !== "oauth") return undefined;
    const headers = new Headers({ Authorization: `Bearer ${credential.access}`, Accept: "application/json" });
    try {
        const payload = JSON.parse(Buffer.from(credential.access.split(".")[1], "base64url").toString());
        const account = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (typeof account === "string") headers.set("ChatGPT-Account-Id", account);
    } catch { /* 非 JWT 凭据仍可尝试 Bearer 认证，不记录凭据。 */ }
    try {
        const timeout = AbortSignal.timeout(5000);
        const response = await fetcher("https://chatgpt.com/backend-api/wham/usage", {
            headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) { await response.body?.cancel(); return undefined; }
        return parseUsage(await response.json());
    } catch { return undefined; }
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { wrapCodex, isQuotaError } from "../.pi/extensions/multi-accounts/stream.ts";
import { AccountStore } from "../.pi/extensions/multi-accounts/store.ts";

async function fixture(run: (store: AccountStore) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "pi-accounts-stream-"));
    try { await run(new AccountStore(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}
const a = { type: "oauth" as const, access: "fake-a", refresh: "fake-ra", expires: 1 };
const b = { type: "oauth" as const, access: "fake-b", refresh: "fake-rb", expires: 2 };
test("只接受结构化订阅额度拒绝，不接受普通429或文案", () => {
    assert.equal(isQuotaError(429, { error: { code: "usage_limit_reached" } }), true);
    assert.equal(isQuotaError(429, { error: { type: "usage_limit_reached" } }), true);
    assert.equal(isQuotaError(429, { error: { code: "rate_limit_exceeded" } }), false);
    assert.equal(isQuotaError(500, { error: { code: "usage_limit_reached" } }), false);
});
for (const scenario of ["quota", "recovered", "skip-exhausted", "unavailable", "probe-failed", "rate", "started", "abort"] as const) {
    test(`流包装：${scenario}`, () => fixture(async store => {
        await store.save("openai-codex", a, "A", true);
        if (scenario === "skip-exhausted") await store.save("openai-codex", { ...b, access: "fake-c" }, "C");
        await store.save("openai-codex", b, "B");
        await store.update("openai-codex", pool => {
            pool.auto = true;
            if (scenario === "recovered") pool.accounts[1].blockedModels = [openaiCodexProvider().getModels()[0].id];
        });
        const base = openaiCodexProvider();
        const model = base.getModels()[0];
        assert.ok(model);
        const controller = new AbortController();
        let requests = 0;
        const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "error", errorMessage: "mock",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const fake = (options?: SimpleStreamOptions) => {
            const stream = createAssistantMessageEventStream();
            void (async () => {
                const response = await options!.fetch!("https://example.invalid", { headers: { Authorization: `Bearer ${options!.apiKey}` } });
                if (response.ok) { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message: { ...message, stopReason: "stop" } }); }
                else {
                    if (scenario === "started") stream.push({ type: "start", partial: message });
                    if (scenario === "abort") controller.abort();
                    stream.push({ type: "error", reason: "error", error: message });
                }
                stream.end();
            })();
            return stream;
        };
        const wrapped = wrapCodex({ ...base, streamSimple: (_m, _c, options) => fake(options) }, store,
            async () => { const s = await store.snapshot("openai-codex"); return s.current?.type === "oauth" ? s.current.access : undefined; }, () => {});
        const events = [];
        for await (const event of wrapped.streamSimple(model, normalizeContext({ messages: [] }), {
            apiKey: a.access, signal: controller.signal,
            fetch: async (_url, init) => {
                if (String(_url).endsWith("/wham/usage")) {
                    if (new Headers(init?.headers).get("Authorization") === "Bearer fake-c") {
                        return Response.json({ rate_limit: { allowed: false, limit_reached: true,
                            primary_window: { used_percent: 100, reset_at: 9999999999 } } });
                    }
                    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${b.access}`);
                    if (scenario === "probe-failed") return new Response("", { status: 503 });
                    return Response.json({ rate_limit: { allowed: scenario !== "unavailable", limit_reached: scenario === "unavailable",
                        primary_window: { used_percent: scenario === "unavailable" ? 100 : 1, reset_at: 9999999999 } } });
                }
                requests++;
                if (new Headers(init?.headers).get("Authorization") === `Bearer ${b.access}`) return new Response("", { status: 200 });
                return Response.json({ error: { code: scenario === "rate" ? "rate_limit_exceeded" : "usage_limit_reached", resets_at: 9999999999 } }, { status: 429 });
            },
        })) events.push(event);
        const succeeds = scenario === "quota" || scenario === "recovered" || scenario === "skip-exhausted";
        assert.equal(requests, succeeds ? 2 : 1);
        if (scenario === "unavailable" || scenario === "probe-failed") {
            const snapshot = await store.snapshot("openai-codex");
            assert.equal(snapshot.current?.type === "oauth" ? snapshot.current.access : undefined, a.access);
            assert.equal(snapshot.pool.accounts[0].quotaResets?.[model.id], 9999999999000);
        }
        assert.equal(events.filter(e => e.type === "done" || e.type === "error").length, 1);
        assert.equal(events.at(-1)?.type, succeeds ? "done" : "error");
    }));
}
test("账号库损坏时不影响未启用轮换的原生请求", () => fixture(async store => {
    await store.save("openai-codex", a, "A", true);
    await writeFile(store.databasePath, "broken");
    const base = openaiCodexProvider();
    const model = base.getModels()[0];
    let calls = 0;
    const wrapped = wrapCodex({ ...base, streamSimple: () => {
        calls++;
        const stream = createAssistantMessageEventStream();
        stream.end();
        return stream;
    } }, store, async () => undefined, () => {});
    for await (const _event of wrapped.streamSimple(model, normalizeContext({ messages: [] }), { apiKey: a.access })) { /* 消费原生空流。 */ }
    assert.equal(calls, 1);
}));
test("原生模型异常不得误报为账号轮换失败且不泄露底层信息", () => fixture(async store => {
    await store.save("openai-codex", a, "A", true);
    await store.update("openai-codex", pool => { pool.auto = true; });
    const base = openaiCodexProvider();
    const wrapped = wrapCodex({ ...base, streamSimple: () => { throw new Error("secret-token-do-not-print"); } },
        store, async () => undefined, () => {});
    const events = [];
    for await (const event of wrapped.streamSimple(base.getModels()[0], normalizeContext({ messages: [] }), { apiKey: a.access })) events.push(event);
    const last = events.at(-1);
    assert.equal(last?.type, "error");
    if (last?.type === "error") {
        assert.match(last.error.errorMessage!, /模型请求阶段失败/);
        assert.doesNotMatch(last.error.errorMessage!, /secret-token|账号轮换失败/);
    }
}));
test("扩展与宿主 FileAuthStorageBackend 跨进程共用锁", () => fixture(async store => {
    await store.save("codex", a, "A", true);
    const id = await store.save("codex", b, "B");
    const module = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/auth-storage.js")).href;
    const script = `import {FileAuthStorageBackend} from ${JSON.stringify(module)}; const b=new FileAuthStorageBackend(${JSON.stringify(store.authPath)}); await b.withLockAsync(async()=>{console.log('locked'); await new Promise(r=>setTimeout(r,3500)); return {result:undefined};});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    const exit = once(child, "exit");
    await once(child.stdout, "data");
    const start = Date.now();
    await store.use("codex", id);
    assert.ok(Date.now() - start >= 3000);
    assert.equal((await exit)[0], 0);
}));

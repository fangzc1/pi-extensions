import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type StreamOptions } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { RequestDiagnostics, errorFacts } from "../.pi/extensions/model-collaboration/diagnostics.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
test("诊断保留原事件流、状态与时间，不保存密钥、正文、响应头或原始异常", async () => {
    const records: Record<string, unknown>[] = [];
    const diagnostic = new RequestDiagnostics("unused", (record) => records.push(record));
    const stream = createAssistantMessageEventStream();
    let hooks: StreamOptions | undefined;
    let forwarded = 0;
    assert.equal(diagnostic.observe({ ...model, baseUrl: "https://secret:password@example.com/v1?key=SECRET" }, {
        onResponse: () => { forwarded++; }, onProviderStreamEvent: () => { forwarded++; },
    }, (options) => { hooks = options; return stream; }), stream);
    await hooks!.onResponse!({ status: 200, headers: { authorization: "SECRET" } }, model);
    await hooks!.onProviderStreamEvent!({ content: "PRIVATE PROMPT", reasoning_content: "PRIVATE THINKING" }, model);
    const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: "error", errorMessage: "terminated: other side closed (UND_ERR_SOCKET) SECRET", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "error", reason: "error", error: message });
    stream.end();
    await stream.result();
    await Promise.resolve();
    const last = records.at(-1)!;
    assert.equal(last.event, "request_end");
    assert.equal(last.status, 200);
    assert.equal(last.chunks, 1);
    assert.deepEqual((last.error as { codes: string[] }).codes, ["UND_ERR_SOCKET"]);
    assert.equal(forwarded, 2);
    assert.ok(typeof last.elapsedMs === "number");
    const text = JSON.stringify(records);
    for (const secret of ["SECRET", "PRIVATE", "password", "authorization"]) assert.ok(!text.includes(secret));
    assert.equal(records[0].endpoint, "https://example.com");
});

test("底层 cause 仅提取白名单字段，诊断写入失败不影响请求", () => {
    assert.deepEqual(errorFacts(new TypeError("SECRET", { cause: Object.assign(new Error("PRIVATE"), { code: "ECONNRESET" }) })),
        { name: "TypeError", codes: ["ECONNRESET"], category: "unknown" });
    const diagnostic = new RequestDiagnostics("unused", () => { throw new Error("disk full"); });
    diagnostic.event("task_start");
    assert.equal(diagnostic.failed, true);
    const error = new Error("transport failed", { cause: { code: "ETIMEDOUT" } });
    assert.throws(() => diagnostic.observe(model, {}, () => { throw error; }), (actual) => actual === error);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../.pi/extensions/model-collaboration/index.ts";

const socketError = "terminated: other side closed (UND_ERR_SOCKET)";

async function runScenario(errors: string[], cancelOnRetry = false, withTool = false, retryEnabled = true) {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-retry-agent-"));
    let tool: ToolDefinition | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    extension({
        getSettings: () => ({ retry: { enabled: retryEnabled, maxRetries: 2, baseDelayMs: 1 } }),
        registerCommand() {}, registerTool(value: ToolDefinition) { tool = value; },
        on(name: string, handler: () => Promise<void>) { if (name === "session_shutdown") shutdown = handler; },
    } as unknown as ExtensionAPI);
    let calls = 0;
    const contexts: unknown[][] = [];
    const updates: string[] = [];
    const controller = new AbortController();
    const model = getModel("anthropic", "claude-sonnet-4-5")!;
    const ctx = {
        cwd: mkdtempSync(join(tmpdir(), "pi-retry-")), scopedModels: [{ model }], model,
        sessionManager: { getSessionId: () => "retry-test" },
        modelRegistry: {
            async getProviderAuth() { return { auth: {}, source: "test" }; },
            streamSimple(_model: unknown, context: { messages: unknown[] }) {
                contexts.push(context.messages);
                const index = calls++;
                const error = errors[index];
                const message: AssistantMessage = {
                    role: "assistant", content: [{ type: "text", text: error ? "" : "评审完成" }],
                    api: model.api, provider: model.provider, model: model.id,
                    stopReason: error ? "error" : "stop", errorMessage: error, timestamp: Date.now(),
                    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                };
                const stream = createAssistantMessageEventStream();
                if (withTool && index === 0) {
                    message.content = [{ type: "toolCall", id: "only-once", name: "ls", arguments: { path: "." } }];
                    message.stopReason = "toolUse";
                    stream.push({ type: "done", reason: "toolUse", message });
                } else if (error) stream.push({ type: "error", reason: "error", error: message });
                else stream.push({ type: "done", reason: "stop", message });
                stream.end();
                return stream;
            },
        },
    } as unknown as ExtensionToolContext;
    try {
        const result = await tool!.execute("retry-test", { model: `${model.provider}/${model.id}`, task: "独立评审", access: "read" }, controller.signal,
            (update) => {
                const text = update.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
                updates.push(text);
                if (cancelOnRetry && text.includes("重试")) controller.abort();
            }, ctx);
        return { result, calls, updates, contexts };
    } finally {
        await shutdown?.();
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
}

test("socket 中断在同一子会话自动恢复，并展示重试进度", async () => {
    const { result, calls, updates } = await runScenario([socketError]);
    assert.ok(!result.isError, JSON.stringify(result.content));
    assert.equal(calls, 2);
    assert.ok(updates.some((text) => text.includes("重试 1/2")));
});

test("持续中断遵守重试上限，认证错误不重试", async () => {
    const failed = await runScenario([socketError, socketError, socketError]);
    assert.equal(failed.calls, 3);
    assert.equal(failed.result.isError, true);
    const auth = await runScenario(["401 Unauthorized: invalid API key"]);
    assert.equal(auth.calls, 1);
    assert.equal(auth.result.isError, true);
});

test("尊重主会话显式关闭重试的设置", async () => {
    const { calls, result } = await runScenario([socketError], false, false, false);
    assert.equal(calls, 1);
    assert.equal(result.isError, true);
});

test("Esc 可取消重试等待，不再发出下一次请求", async () => {
    const { result, calls } = await runScenario([socketError], true);
    assert.equal(calls, 1);
    assert.equal(result.isError, true);
    assert.equal((result.details as { status: string }).status, "已取消");
});

test("中途断线从已有工具结果继续，不重新执行整个任务", async () => {
    const { result, calls, contexts } = await runScenario(["", socketError], false, true);
    assert.ok(!result.isError, JSON.stringify(result.content));
    assert.equal(calls, 3);
    const last = contexts.at(-1) as Array<{ role: string; toolCallId?: string }>;
    assert.equal(last.filter((message) => message.role === "toolResult" && message.toolCallId === "only-once").length, 1);
    assert.equal(last.filter((message) => message.role === "user").length, 1);
});

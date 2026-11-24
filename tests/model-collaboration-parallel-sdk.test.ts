import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../.pi/extensions/model-delegation/index.ts";

test("真实 SDK 并行与续聊分别绑定当前进度和诊断", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const dir = mkdtempSync(join(tmpdir(), "pi-parallel-sdk-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    let tool!: ToolDefinition;
    let shutdown!: () => Promise<void>;
    extension({
        getSettings: () => ({}), registerCommand() {},
        registerTool(value: ToolDefinition) { tool = value; },
        on(name: string, handler: () => Promise<void>) { if (name === "session_shutdown") shutdown = handler; },
    } as unknown as ExtensionAPI);
    const model = getModel("anthropic", "claude-sonnet-4-5")!;
    const releases: (() => void)[] = [];
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    let calls = 0;
    const ctx = {
        cwd: dir, model, scopedModels: [{ model }], sessionManager: { getSessionId: () => "parallel-sdk" },
        modelRegistry: {
            async getProviderAuth() { return { auth: {}, source: "test" }; },
            streamSimple() {
                const index = calls++;
                const stream = createAssistantMessageEventStream();
                const message = {
                    role: "assistant" as const, content: [{ type: "text" as const, text: `意见-${index}` }],
                    api: model.api, provider: model.provider, model: model.id,
                    stopReason: "stop" as const, timestamp: Date.now(),
                    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                };
                const finish = () => {
                    stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
                    stream.push({ type: "done", reason: "stop", message });
                    stream.end();
                };
                if (index < 2) {
                    releases[index] = finish;
                    if (calls === 2) bothStarted();
                } else finish();
                return stream;
            },
        },
    } as unknown as ExtensionToolContext;
    const updates: string[][] = [[], [], []];
    const execute = (index: number, threadId?: string) => tool.execute(String(index), {
        model: `${model.provider}/${model.id}`, access: "read", task: `讨论-${index}`, threadId,
    }, undefined, (update) => updates[index].push(JSON.stringify(update)), ctx);
    try {
        const a = execute(0);
        const b = execute(1);
        // 两个请求都启动后才允许任何一个返回，证明并发而非仅比较总耗时。
        await started;
        releases[0]();
        const first = await a;
        assert.ok(!first.isError);
        const follow = await execute(2, (first.details as { threadId: string }).threadId);
        assert.ok(!follow.isError);
        releases[1]();
        const second = await b;
        assert.ok(!second.isError);
        assert.ok(updates[0].join().includes("意见-0"));
        assert.ok(!updates[0].join().includes("意见-1"));
        assert.ok(!updates[0].join().includes("意见-2"));
        assert.ok(updates[1].join().includes("意见-1"));
        assert.ok(!updates[1].join().includes("意见-0"));
        assert.ok(updates[2].join().includes("意见-2"));
        const records = readFileSync(join(dir, "model-collaboration-diagnostics", "parallel-sdk.jsonl"), "utf8")
            .trim().split("\n").map((line) => JSON.parse(line));
        for (const result of [first, second, follow]) {
            const taskId = (result.details as { taskId: string }).taskId;
            const events = records.filter((record) => record.taskId === taskId).map((record) => record.event);
            assert.equal(events.filter((event) => event === "request_start").length, 1);
            assert.ok(events.includes("request_end"));
            assert.ok(events.includes("task_end"));
        }
    } finally {
        for (const release of releases) release();
        await shutdown();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    }
});

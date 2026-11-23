import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../.pi/extensions/model-collaboration/index.ts";
import { join } from "node:path";
import { ConfigStore, resolveModel, Collaboration, toolsForAccess } from "../.pi/extensions/model-collaboration/core.ts";

const models = [{ provider: "p", id: "a" }, { provider: "p", id: "b" }, { provider: "q", id: "b" }];
test("模型完整名、唯一简写、歧义、越界与默认值均经过校验", () => {
    assert.equal(resolveModel(models, "p/b").provider, "p");
    assert.equal(resolveModel(models, "a").id, "a");
    assert.throws(() => resolveModel(models, "b"), /多个/);
    assert.throws(() => resolveModel(models, "x"), /可用模型/);
    assert.equal(resolveModel(models, undefined, "p/b", "p/a").id, "b");
    assert.throws(() => resolveModel(models, undefined, "p/a", "p/a"), /相同/);
    assert.throws(() => resolveModel(models), /默认模型/);
});
test("provider 简称仅在当前范围唯一时匹配，完整名和模型 ID 保持优先", () => {
    const deepseek = { provider: "deepseek", id: "deepseek-flash" };
    const pro = { provider: "deepseek", id: "deepseek-v4-pro" };
    assert.equal(resolveModel([deepseek], "deepseek"), deepseek);
    assert.throws(() => resolveModel([deepseek, pro], "deepseek"), /匹配到多个模型/);
    assert.equal(resolveModel([deepseek, pro], "deepseek/deepseek-flash"), deepseek);
    assert.equal(resolveModel([deepseek, pro], "deepseek-flash"), deepseek);
    assert.throws(() => resolveModel(models, "deepseek"), /模型不在当前范围内/);
    const exactId = { provider: "other", id: "deepseek" };
    assert.equal(resolveModel([deepseek, exactId], "deepseek"), exactId);
    assert.throws(() => resolveModel([deepseek], "deep"), /模型不在当前范围内/);
});

test("子模型配置独立保存并在新实例中恢复", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-collab-")), "config.json");
    const store = new ConfigStore(path);
    store.update((config) => { config.defaultModel = "p/a"; config.levels["p/a"] = "high"; });
    assert.deepEqual(new ConfigStore(path).read(), { defaultModel: "p/a", levels: { "p/a": "high" } });
    assert.ok(readFileSync(path, "utf8").includes("high"));
});
test("损坏配置不被静默覆盖", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-collab-invalid-")), "config.json");
    writeFileSync(path, "broken");
    const store = new ConfigStore(path);
    assert.throws(() => store.update(() => {}), /JSON/);
    assert.equal(readFileSync(path, "utf8"), "broken");
    writeFileSync(path, JSON.stringify({ levels: { "p/a": "invalid" } }));
    assert.throws(() => store.read(), /字段/);
});

test("只读权限不包含 shell 和文件写工具", () => {
    assert.deepEqual(toolsForAccess("read"), ["read", "grep", "find", "ls"]);
    assert.ok(toolsForAccess("write").includes("bash"));
});
test("线程保留历史、串行互斥、取消传递和释放", async () => {
    let disposed = 0;
    let cancelled = false;
    const prompts: string[] = [];
    const collaboration = new Collaboration(async () => ({
        async prompt(text, signal) {
            prompts.push(text);
            if (text === "wait") await new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true });
            });
            return "answer";
        },
        dispose() { disposed++; },
    }));
    const first = await collaboration.run({ model: "p/a", level: "high", access: "read", task: "first" });
    await collaboration.run({ model: "p/a", level: "high", access: "read", task: "second", threadId: first.threadId });
    assert.deepEqual(prompts, ["first", "second"]);
    await assert.rejects(collaboration.run({ model: "p/b", level: "high", access: "read", task: "x", threadId: first.threadId }), /模型/);
    const controller = new AbortController();
    const running = collaboration.run({ model: "p/a", level: "high", access: "read", task: "wait", threadId: first.threadId }, controller.signal);
    await assert.rejects(collaboration.run({ model: "p/a", level: "high", access: "read", task: "x" }), /正在执行/);
    controller.abort();
    await assert.rejects(running, /取消/);
    assert.equal(cancelled, true);
    await assert.rejects(collaboration.run({ model: "p/a", level: "high", access: "write", task: "x", threadId: first.threadId }), /权限/);
    await collaboration.clear();
    assert.throws(() => collaboration.describe(first.threadId), /失效/);
    assert.equal(disposed, 1);
});

test("真实 SDK 子会话复用主 registry，隔离协作工具并连续追问", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-diagnostics-agent-"));
    let tool: ToolDefinition | undefined;
    const handlers = new Map<string, () => Promise<void>>();
    let configure: ((_args: string, ctx: ExtensionToolContext) => Promise<void>) | undefined;
    extension({
        getSettings: () => ({}),
        registerCommand(_name: string, command: { handler: typeof configure }) { configure = command.handler; },
        registerTool(definition: ToolDefinition) { tool = definition; },
        on(name: string, handler: () => Promise<void>) { handlers.set(name, handler); },
    } as unknown as ExtensionAPI);
    const model = getModel("anthropic", "claude-sonnet-4-5")!;
    assert.ok(model);
    const histories: number[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "pi-collab-sdk-"));
    const ctx = {
        cwd, scopedModels: [{ model }], model,
        sessionManager: { getSessionId: () => "integration-test" },
        modelRegistry: {
            async getProviderAuth() { return { auth: {}, source: "test" }; },
            streamSimple(selected: typeof model, context: { messages: unknown[]; tools?: { name: string }[] }) {
                assert.equal(selected.id, model.id);
                assert.ok(!context.tools?.some((item) => item.name === "subagent" || item.name === "bash"));
                histories.push(context.messages.length);
                const stream = createAssistantMessageEventStream();
                const message = {
                    role: "assistant" as const, content: [{ type: "text" as const, text: "独立评审意见" }],
                    api: model.api, provider: model.provider, model: model.id,
                    stopReason: "stop" as const, timestamp: Date.now(),
                    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                };
                if (histories.length === 1) {
                    message.content[0].text = "先读取相关文件。";
                    const partial = { ...message, content: [{ type: "text" as const, text: "先读取" }] };
                    stream.push({ type: "text_delta", contentIndex: 0, delta: "先读取", partial });
                    stream.push({ type: "text_delta", contentIndex: 0, delta: "相关文件。", partial: message });
                    const toolMessage = { ...message, stopReason: "toolUse" as const, content: [
                        ...message.content,
                        { type: "toolCall" as const, id: "read-one", name: "read", arguments: { path: "missing-one.md" } },
                        { type: "toolCall" as const, id: "read-two", name: "read", arguments: { path: "missing-two.md" } },
                    ] };
                    stream.push({ type: "done", reason: "toolUse", message: toolMessage });
                } else stream.push({ type: "done", reason: "stop", message });
                stream.end();
                return stream;
            },
        },
    } as unknown as ExtensionToolContext;
    try {
        assert.equal(tool?.executionMode, "sequential");
        const updates: string[] = [];
        const first = await tool!.execute("1", { model: `${model.provider}/${model.id}`, access: "read", task: "评审" }, undefined,
            (update) => { updates.push(update.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")); }, ctx);
        assert.ok(updates.some((text) => text.includes("读取 missing-one.md")), updates.join("\n"));
        assert.ok(updates.some((text) => text.includes("读取 missing-two.md")), updates.join("\n"));
        assert.ok(updates.some((text) => text.includes("失败")), updates.join("\n"));
        assert.ok(updates.every((text) => !text.includes("正在调用 read正在调用")));
        assert.ok(!first.isError, JSON.stringify(first.content));
        const theme = { fg: (_color: string, text: string) => text };
        const view = tool!.renderResult!(first, { expanded: true, isPartial: false } as never, theme as never, {} as never);
        const rendered = view.render(40);
        assert.ok(rendered.every((line) => visibleWidth(line) <= 40));
        assert.ok(rendered.join("\n").includes("读取 missing-one.md"));
        assert.ok(rendered.join("\n").includes("失败"));
        const call = tool!.renderCall!({ model: "p/a", access: "read", task: "评审方案" }, theme as never, {} as never).render(40).join("\n");
        assert.ok(call.includes("模型协作") && call.includes("评审方案"));
        assert.ok(!call.includes('task='));
        const threadId = (first.details as { threadId: string }).threadId;
        const next = await tool!.execute("2", { threadId, access: "read", task: "继续" }, undefined, undefined, ctx);
        assert.ok(!next.isError, JSON.stringify(next.content));
        assert.ok(histories[1] > histories[0]);
        let lines: string[] = [];
        await configure!("", {
            ...ctx, hasUI: true, mode: "tui", scopedModels: [],
            modelRegistry: { getAvailable: () => [model] },
            ui: { custom: async (factory: Function) => {
                const panel = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
                lines = panel.render(120);
                panel.handleInput("\u001b");
                return undefined;
            } },
        } as unknown as ExtensionToolContext);
        assert.ok(lines.some((item) => item.includes(`${model.provider}/${model.id}`)));
        const denied = await tool!.execute("3", { model: `${model.provider}/${model.id}`, access: "write", task: "修改" }, undefined, undefined, ctx);
        assert.equal(denied.isError, true);
    } finally {
        await handlers.get("session_shutdown")?.();
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
});

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import antigravityCli from "../.pi/extensions/antigravity-cli/index.ts";
import { ConfigStore } from "../.pi/extensions/antigravity-cli/config.ts";
import { AGY_ENTRY_TYPE, AGY_MESSAGE_TYPE, AGY_USER_ENTRY_TYPE } from "../.pi/extensions/antigravity-cli/renderer.ts";

const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    dim: (text: string) => text,
};

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`等待条件超时（>${timeoutMs}ms）`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function createMockAgyExecutable(root: string, name: string): Promise<string> {
    const filePath = join(root, name);
    const script = `#!/usr/bin/env node
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("models")) {
    process.stdout.write([
        "gemini-4-neon-low\\tGemini 4 Neon (Low)",
        "gemini-4-neon-high\\tGemini 4 Neon (High)",
        "gemini-4-neon-xhigh\\tGemini 4 Neon (XHigh)",
        "gemini-pro-orchestrator-neon\\tOrchestrator (Neon)",
    ].join("\\n") + "\\n");
    process.exit(0);
}

let sessionId = "e2e-conv-1";
let currentModel = "default";
let currentEffort = "default";
const mode = args.includes("--dangerously-skip-permissions") ? "auto-all" : "normal";
let activePromptId = null;
let pendingElicitation = null;

function send(obj) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);

    if (!msg.method && msg.id !== undefined) {
        if (pendingElicitation && msg.id === pendingElicitation.reqId) {
            const promptId = pendingElicitation.promptId;
            pendingElicitation = null;
            const reply = "**答题完成**：" + JSON.stringify(msg.result);
            send({
                method: "session/update",
                params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } },
            });
            activePromptId = null;
            send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } } });
        }
        return;
    }

    if (msg.method === "initialize") {
        send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
        return;
    }
    if (msg.method === "session/new") {
        send({
            id: msg.id,
            result: {
                sessionId,
                configOptions: [
                    { id: "model", currentValue: currentModel, options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
                    { id: "thought_level", currentValue: currentEffort, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "xhigh", name: "Extra" }] },
                ],
            },
        });
        return;
    }
    if (msg.method === "session/resume") {
        sessionId = msg.params.sessionId;
        send({
            id: msg.id,
            result: {
                sessionId,
                configOptions: [
                    { id: "model", currentValue: currentModel, options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
                    { id: "thought_level", currentValue: currentEffort, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "xhigh", name: "Extra" }] },
                ],
            },
        });
        return;
    }
    if (msg.method === "session/set_config_option") {
        if (msg.params.configId === "model") currentModel = msg.params.value;
        if (msg.params.configId === "thought_level") currentEffort = msg.params.value;
        send({ id: msg.id, result: {} });
        return;
    }
    if (msg.method === "session/cancel") {
        if (activePromptId !== null) {
            const pid = activePromptId;
            activePromptId = null;
            send({ id: pid, result: { stopReason: "cancelled" } });
        }
        return;
    }
    if (msg.method === "session/prompt") {
        activePromptId = msg.id;
        const blocks = msg.params.prompt || [];
        const content = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\\n");
        const imgCount = blocks.filter((b) => b.type === "image").length;

        if (content === "SLOW") {
            send({
                method: "session/update",
                params: {
                    sessionId,
                    update: { sessionUpdate: "tool_call", toolCallId: "tc-slow", name: "run_command", status: "in_progress", rawInput: { CommandLine: "sleep 30" } },
                },
            });
            return;
        }

        if (content === "ASK_MATH") {
            pendingElicitation = { reqId: "q-req-1", promptId: msg.id };
            send({
                id: "q-req-1",
                method: "elicitation/create",
                params: {
                    sessionId,
                    toolCallId: "tc-ask",
                    mode: "form",
                    message: "The agent has a question.",
                    requestedSchema: {
                        type: "object",
                        properties: {
                            q1: {
                                type: "string",
                                title: "6 × 7 等于多少？",
                                oneOf: [
                                    { const: "1", title: "42" },
                                    { const: "2", title: "48" },
                                ],
                            },
                            q1_other: { type: "string", title: "Other" },
                            q2: {
                                type: "array",
                                title: "选择偶数",
                                items: {
                                    anyOf: [
                                        { const: "1", title: "2" },
                                        { const: "2", title: "3" },
                                        { const: "3", title: "4" },
                                    ],
                                },
                            },
                            q2_other: { type: "string", title: "Other" },
                        },
                    },
                },
            });
            return;
        }

        send({
            method: "session/update",
            params: {
                sessionId,
                update: { sessionUpdate: "tool_call", toolCallId: "tc-1", name: "grep_search", status: "completed", rawInput: { Query: content } },
            },
        });
        const response = "[" + mode + "|" + currentModel + "|" + currentEffort + "|" + sessionId + "|imgs=" + imgCount + "] 回复：" + content;
        send({
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: response } } },
        });
        activePromptId = null;
        send({ id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } } });
    }
});
`;
    await writeFile(filePath, script, "utf8");
    await chmod(filePath, 0o755);
    return filePath;
}

test("端到端：/agy 接管 -> 立即显示用户消息 -> ask_question 单/多选作答 -> /agy-config 切到函数 a 与模型 -> Esc 取消 -> /agy-exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-e2e-"));
    const mockAgy = await createMockAgyExecutable(root, "agy");
    const rcFile = join(root, ".zshrc");
    const configPath = join(root, "antigravity-cli.json");
    await writeFile(
        rcFile,
        `a() {\n  echo "✅ 终端代理已开启"\n  "${mockAgy}" --dangerously-skip-permissions "$@"\n}\n`,
        "utf8",
    );

    const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const messageRenderers = new Map<string, any>();
    const entryRenderers = new Map<string, any>();
    const sentMessages: Array<{ message: any; options: any }> = [];
    const appendedEntries: Array<{ customType: string; data: any }> = [];
    const notifications: Array<{ message: string; level: string }> = [];
    const statuses = new Map<string, string | undefined>();
    const widgets = new Map<string, any>();
    const terminalListeners = new Set<(data: string) => any>();
    let editorFactory: ((tui: any, theme: any, keybindings: any) => any) | undefined = () => ({
        borderColor: (t: string) => t,
        render: (width: number) => [`${"─".repeat(width - 11)} 笑话一则 ─`, "", "─".repeat(width)],
    });
    const renderEditorTopBorder = () => {
        const editor = editorFactory!({ requestRender: () => {} }, { borderColor: (t: string) => t }, {});
        return editor.render(70)[0] as string;
    };

    // select 队列：先答 ASK_MATH 的单选题 q1（选 1. 42），再跑 /agy-config 改命令和模型，最后返回 undefined 模拟按 Esc 退出。
    const selectQueue: Array<string | undefined> = [
        "1. 42",
        "1. 底层命令：agy",
        "2. 开启模型：跟随 agy 默认",
        "2. Gemini 4 Neon (gemini-4-neon) [low/high/xhigh]",
        "3. xhigh",
        undefined,
    ];
    const inputQueue = ["a"];

    const pi = {
        on(event: string, handler: (event: any, ctx: any) => Promise<any>) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
            commands.set(name, spec);
        },
        registerMessageRenderer(customType: string, renderer: any) {
            messageRenderers.set(customType, renderer);
        },
        registerEntryRenderer(customType: string, renderer: any) {
            entryRenderers.set(customType, renderer);
        },
        sendMessage(message: any, options: any) {
            sentMessages.push({ message, options });
        },
        appendEntry(customType: string, data: any) {
            appendedEntries.push({ customType, data });
        },
    };

    const ctx = {
        cwd: root,
        mode: "tui",
        hasUI: true,
        ui: {
            theme: fakeTheme,
            notify: (message: string, level = "info") => notifications.push({ message, level }),
            setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
            getEditorComponent: () => editorFactory,
            setEditorComponent: (factory: any) => { editorFactory = factory; },
            setWidget: (key: string, factory: any) => {
                if (factory === undefined) widgets.delete(key);
                else widgets.set(key, factory);
            },
            onTerminalInput: (handler: (data: string) => any) => {
                terminalListeners.add(handler);
                return () => terminalListeners.delete(handler);
            },
            select: async (_title: string, _options: string[]) => selectQueue.shift(),
            input: async (_title: string, _placeholder?: string) => inputQueue.shift(),
            confirm: async () => true,
            // 驱动自定义组件：多选组件执行勾选提交，模型加载提示框等待自动关闭。
            custom: async (factory: (tui: any, theme: any, keys: any, done: (val: any) => void) => any) => {
                return new Promise((resolve) => {
                    const panel = factory(
                        { requestRender: () => {} },
                        fakeTheme,
                        { matches: () => false },
                        resolve,
                    );
                    const rendered = panel.render(80);
                    if (rendered.some((line: string) => line.includes("选择偶数"))) {
                        panel.handleInput(" ");
                        panel.handleInput("j");
                        panel.handleInput("j");
                        panel.handleInput(" ");
                        panel.handleInput("\r");
                    }
                });
            },
        },
    };

    async function emitInput(text: string, images?: any[]): Promise<any> {
        const list = handlers.get("input") ?? [];
        for (const handler of list) {
            const result = await handler({ type: "input", text, images, source: "interactive" }, ctx);
            if (result && result.action !== "continue") return result;
        }
        return { action: "continue" };
    }

    async function emitLifecycle(name: string): Promise<void> {
        for (const handler of handlers.get(name) ?? []) {
            await handler({ type: name }, ctx);
        }
    }

    try {
        antigravityCli(pi as any, {
            configStore: new ConfigStore(configPath),
            probeOptions: {
                env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, HOME: root },
                rcFile,
            },
        });

        await emitLifecycle("session_start");
        assert.deepEqual(await emitInput("交给主模型"), { action: "continue" });

        // 1. /agy 进入接管模式：左上角边框显示 AGY(agy) 且保留右侧会话名，不在右下角状态栏重复显示。
        await commands.get("agy")!.handler("", ctx);
        assert.equal(statuses.get("antigravity-cli"), undefined);
        assert.ok(renderEditorTopBorder().startsWith("─ AGY(agy) ─"));
        assert.ok(renderEditorTopBorder().endsWith(" 笑话一则 ─"));

        // 2. 带图片附件的普通消息应直接通过 ACP 发送并立即渲染用户气泡。
        assert.deepEqual(
            await emitInput("第一轮问题", [{ type: "image", data: "abc", mimeType: "image/png" }]),
            { action: "handled" },
        );
        const userEntriesAfterSend = appendedEntries.filter((entry) => entry.customType === AGY_USER_ENTRY_TYPE);
        assert.equal(userEntriesAfterSend.length, 1);
        assert.equal(userEntriesAfterSend[0]!.data.prompt, "第一轮问题");

        await waitFor(() => sentMessages.length === 1);
        const firstMsg = sentMessages[0]!.message;
        assert.equal(firstMsg.customType, AGY_MESSAGE_TYPE);
        assert.ok(firstMsg.content.includes("[normal|default|default|e2e-conv-1|imgs=1] 回复：第一轮问题"));

        // 3. 触发 ask_question 问卷（单选 + 多选），验证作答成功回传给 agy！
        assert.deepEqual(await emitInput("ASK_MATH"), { action: "handled" });
        await waitFor(() => sentMessages.length === 2);
        const askMsg = sentMessages[1]!.message;
        assert.ok(askMsg.content.includes('"action":"accept"'));
        assert.ok(askMsg.content.includes('"q1":"1"'));
        assert.ok(askMsg.content.includes('"q2":["1","3"]'));

        // 4. /agy-config 交互式修改命令为 a，并配置模型 gemini-4-neon + 思考级别 xhigh。
        await commands.get("agy-config")!.handler("", ctx);
        const persisted = JSON.parse(await readFile(configPath, "utf8"));
        assert.equal(persisted.command, "a");
        assert.equal(persisted.model, "gemini-4-neon");
        assert.equal(persisted.effort, "xhigh");
        assert.equal(statuses.get("antigravity-cli"), undefined);
        assert.ok(renderEditorTopBorder().startsWith("─ AGY(a · gemini-4-neon[xhigh]) ─"));
        assert.ok(renderEditorTopBorder().endsWith(" 笑话一则 ─"));

        // 5. 修改命令后继续发消息：应走函数 a、设置 model/effort 并按 session/resume 续接！
        assert.deepEqual(await emitInput("第二轮切到a"), { action: "handled" });
        await waitFor(() => sentMessages.length === 3);
        const secondMsg = sentMessages[2]!.message;
        assert.ok(secondMsg.content.includes("[auto-all|gemini-4-neon|xhigh|e2e-conv-1|imgs=0] 回复：第二轮切到a"));
        assert.ok(secondMsg.details.preambleLines?.some((line: string) => line.includes("终端代理已开启")));

        // 6. 模拟长耗时任务并通过单字节 Esc 取消。
        assert.deepEqual(await emitInput("SLOW"), { action: "handled" });
        await waitFor(() => terminalListeners.size === 1 && widgets.has("antigravity-cli-live"));

        assert.deepEqual(await emitInput("抢跑消息"), { action: "handled" });
        assert.ok(notifications.some((item) => item.message.includes("正在处理当前轮次")));

        const isolatedBeforeCancel = appendedEntries.filter((entry) => entry.customType === AGY_ENTRY_TYPE).length;
        for (const listener of [...terminalListeners]) {
            listener("\x1b");
        }
        await waitFor(() => appendedEntries.filter((entry) => entry.customType === AGY_ENTRY_TYPE).length === isolatedBeforeCancel + 1);
        const cancelledEntry = appendedEntries.filter((entry) => entry.customType === AGY_ENTRY_TYPE).at(-1)!;
        assert.equal(cancelledEntry.data.cancelled, true);

        // 7. /agy-exit 退出接管模式，左上角边框恢复原状并恢复主模型。
        await commands.get("agy-exit")!.handler("", ctx);
        assert.equal(statuses.get("antigravity-cli"), undefined);
        assert.ok(!renderEditorTopBorder().includes("AGY("));
        assert.ok(renderEditorTopBorder().endsWith(" 笑话一则 ─"));
        assert.deepEqual(await emitInput("回到主模型"), { action: "continue" });
    } finally {
        await emitLifecycle("session_shutdown");
        await rm(root, { recursive: true, force: true });
    }
});

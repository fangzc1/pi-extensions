import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    createAssistantMessageEventStream,
    createProvider,
    InMemoryCredentialStore,
    type Message,
    type Model,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionAPI,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import antigravityCli from "../.pi/extensions/antigravity-cli/index.ts";
import { ConfigStore } from "../.pi/extensions/antigravity-cli/config.ts";
import { AGY_MESSAGE_TYPE, AGY_USER_ENTRY_TYPE } from "../.pi/extensions/antigravity-cli/renderer.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`等待条件超时（>${timeoutMs}ms）`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function createMockAgyCli(root: string): Promise<string> {
    const scriptPath = join(root, "agy");
    const script = `#!/usr/bin/env node
const readline = require("node:readline");
const args = process.argv.slice(2);
const isAutoAll = args.includes("--dangerously-skip-permissions");
let sessionId = "sdk-conv-001";

function send(obj) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg.method === "initialize") {
        send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === "session/new") {
        send({ id: msg.id, result: { sessionId, configOptions: [] } });
    } else if (msg.method === "session/resume") {
        sessionId = msg.params.sessionId;
        send({ id: msg.id, result: { sessionId, configOptions: [] } });
    } else if (msg.method === "session/set_config_option") {
        send({ id: msg.id, result: {} });
    } else if (msg.method === "session/prompt") {
        const content = (msg.params.prompt || []).map((b) => b.text || "").join("\\n");
        const response = "AGY(" + (isAutoAll ? "a" : "agy") + "|" + sessionId + "): " + content;
        send({
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: response } } },
        });
        send({ id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 } } });
    }
});
`;
    await writeFile(scriptPath, script, "utf8");
    await chmod(scriptPath, 0o755);
    return scriptPath;
}

test("真实 Pi SDK 端到端：/agy 接管不调用主模型，/agy-config 切到函数 a，/agy-exit 后主模型收到同步的精简问答上下文", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agy-sdk-e2e-"));
    const mockAgyPath = await createMockAgyCli(root);
    const rcFile = join(root, ".zshrc");
    const configPath = join(root, "antigravity-cli.json");
    await writeFile(
        rcFile,
        `a() {\n  echo "✅ 终端代理已开启"\n  "${mockAgyPath}" --dangerously-skip-permissions "$@"\n}\n`,
        "utf8",
    );

    const mainModelCalls: Message[][] = [];
    const model: Model<"openai-completions"> = {
        id: "mock-main-model",
        name: "Mock Main Model",
        api: "openai-completions",
        provider: "mock-main",
        baseUrl: "http://127.0.0.1:1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
    };

    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
    });
    const createMockStream = (selected: Model<"openai-completions">, context: TranscriptContext) => {
        mainModelCalls.push([...context.messages]);
        const stream = createAssistantMessageEventStream();
        const message = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: `主模型已接管（共收到 ${context.messages.length} 条上下文消息）` }],
            api: selected.api,
            provider: selected.provider,
            model: selected.id,
            stopReason: "stop" as const,
            timestamp: Date.now(),
            usage: {
                input: 5,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 10,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
        };
        queueMicrotask(() => {
            stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
        });
        return stream;
    };

    modelRuntime.registerNativeProvider(createProvider({
        id: model.provider,
        models: [model],
        auth: { apiKey: { name: "Mock Key", resolve: async () => ({ auth: { apiKey: "mock-key" }, source: "test" }) } },
        api: {
            stream: createMockStream,
            streamSimple: createMockStream,
        },
    }));

    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager,
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
            {
                name: "antigravity-cli-test",
                factory: (pi: ExtensionAPI) => antigravityCli(pi, {
                    configStore: new ConfigStore(configPath),
                    probeOptions: {
                        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, HOME: root },
                        rcFile,
                    },
                }),
            },
        ],
    });
    await loader.reload();

    const { session } = await createAgentSession({
        cwd: root,
        model,
        modelRuntime,
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.inMemory(root),
        tools: [],
    });

    const notifications: string[] = [];
    const statuses = new Map<string, string | undefined>();
    let editorFactory: ((tui: any, theme: any, keybindings: any) => any) | undefined = () => ({
        borderColor: (t: string) => t,
        render: (width: number) => ["─".repeat(width), "", "─".repeat(width)],
    });
    const renderTopBorder = () => {
        const editor = editorFactory!({ requestRender: () => {} }, { borderColor: (t: string) => t }, {});
        return editor.render(60)[0] as string;
    };
    const selectQueue: Array<string | undefined> = ["1. 底层命令：agy", undefined];
    const inputQueue = ["a"];

    await session.bindExtensions({
        uiContext: {
            select: async () => selectQueue.shift(),
            confirm: async () => true,
            input: async () => inputQueue.shift(),
            notify: (message: string) => notifications.push(message),
            onTerminalInput: () => () => {},
            setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
            setWorkingMessage: () => {},
            setWorkingVisible: () => {},
            setWorkingIndicator: () => {},
            setHiddenThinkingLabel: () => {},
            setWidget: () => {},
            setFooter: () => {},
            setHeader: () => {},
            setTitle: () => {},
            custom: async () => undefined,
            pasteToEditor: () => {},
            setEditorText: () => {},
            getEditorText: () => "",
            editor: async () => undefined,
            addAutocompleteProvider: () => {},
            setEditorComponent: (factory: any) => { editorFactory = factory; },
            getEditorComponent: () => editorFactory,
            theme: {
                fg: (_c: string, text: string) => text,
                bg: (_c: string, text: string) => text,
                bold: (text: string) => text,
                italic: (text: string) => text,
                dim: (text: string) => text,
            },
            getAllThemes: () => [],
            getTheme: () => undefined,
            setTheme: () => ({ success: true }),
            getToolsExpanded: () => false,
            setToolsExpanded: () => {},
        } as unknown as ExtensionUIContext,
        mode: "tui",
    });

    try {
        // 1. 进入接管模式：左上角显示 AGY(agy)，底部状态栏不重复显示
        await session.prompt("/agy");
        assert.equal(statuses.get("antigravity-cli"), undefined);
        assert.ok(renderTopBorder().startsWith("─ AGY(agy) ─"));

        // 2. 第一轮对话经 agy 处理，发送瞬间立刻写入用户展示条目，且不触发主模型
        await session.prompt("请帮我分析方案A");
        const userDisplayEntries = session.sessionManager.getBranch().filter(
            (entry) => entry.type === "custom" && entry.customType === AGY_USER_ENTRY_TYPE,
        );
        assert.equal(userDisplayEntries.length, 1, "发送后应立刻在会话流中写入用户消息展示条目");
        await waitFor(() => session.messages.some(
            (msg) => msg.role === "custom" && msg.customType === AGY_MESSAGE_TYPE,
        ));
        assert.equal(mainModelCalls.length, 0, "AGY 模式下不应调用 Pi 主模型");

        // 3. 通过 /agy-config 交互式改命令为 zshrc 函数 a
        await session.prompt("/agy-config");
        assert.equal(statuses.get("antigravity-cli"), undefined);
        assert.ok(renderTopBorder().startsWith("─ AGY(a) ─"));

        // 4. 第二轮对话走函数 a 并续接同一 conversation_id
        await session.prompt("继续推进方案A");
        await waitFor(() => session.messages.filter(
            (msg) => msg.role === "custom" && msg.customType === AGY_MESSAGE_TYPE,
        ).length === 2);
        assert.equal(mainModelCalls.length, 0);

        const agyMessages = session.messages.filter(
            (msg) => msg.role === "custom" && msg.customType === AGY_MESSAGE_TYPE,
        );
        const secondAgyMsg = agyMessages[1];
        assert.ok(secondAgyMsg && secondAgyMsg.role === "custom");
        assert.ok(String(secondAgyMsg.content).includes("AGY(a|sdk-conv-001): 继续推进方案A"));

        // 5. 退出接管模式
        await session.prompt("/agy-exit");
        assert.equal(statuses.get("antigravity-cli"), undefined);
        assert.ok(!renderTopBorder().includes("AGY("));

        // 6. 恢复主模型处理，并验证主模型收到了精简问答上下文
        await session.prompt("请总结前面和 Antigravity 聊的内容");
        assert.equal(mainModelCalls.length, 1, "退出后对话必须由 Pi 主模型处理");

        const serializedContext = JSON.stringify(mainModelCalls[0]);
        assert.ok(serializedContext.includes("请帮我分析方案A"));
        assert.ok(serializedContext.includes("AGY(a|sdk-conv-001): 继续推进方案A"));
        assert.ok(session.getLastAssistantText()?.includes("主模型已接管"));
    } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgyPersistentRunner } from "../.pi/extensions/antigravity-cli/runner.ts";

/** 创建一个模拟 `agy acp`（JSON-RPC 2.0 + elicitation/create + session/resume + session/cancel）的可执行脚本。 */
async function createMockAcpScript(root: string): Promise<{ scriptPath: string; logPath: string }> {
    const scriptPath = join(root, "mock-agy");
    const logPath = join(root, "mock-agy.log");

    const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const args = process.argv.slice(2);
const logPath = process.env.MOCK_AGY_LOG;
if (logPath) {
    fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, args }) + "\\n");
}

let sessionId = "acp-sess-" + process.pid;
let currentModel = "gemini-4-neon";
let currentEffort = "high";
let activePromptId = null;
let pendingElicitation = null;
let pendingPermission = null;

function send(obj) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");
}

function makeConfigOptions() {
    return [
        {
            id: "model",
            name: "Model",
            currentValue: currentModel,
            options: [
                { value: "gemini-4-neon", name: "Gemini 4 Neon" },
                { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
            ],
        },
        {
            id: "thought_level",
            name: "Thinking Level",
            currentValue: currentEffort,
            options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
                { value: "xhigh", name: "Extra" },
            ],
        },
    ];
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);

    // 收到客户端对 elicitation/create 或 session/request_permission 的回复
    if (!msg.method && msg.id !== undefined) {
        if (pendingElicitation && msg.id === pendingElicitation.reqId) {
            const promptId = pendingElicitation.promptId;
            pendingElicitation = null;
            const reply = "问卷结果=" + JSON.stringify(msg.result) + " model=" + currentModel + " effort=" + currentEffort;
            send({
                method: "session/update",
                params: {
                    sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: reply },
                    },
                },
            });
            activePromptId = null;
            send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } });
            return;
        }
        if (pendingPermission && msg.id === pendingPermission.reqId) {
            const promptId = pendingPermission.promptId;
            pendingPermission = null;
            const reply = "权限决定=" + JSON.stringify(msg.result?.outcome);
            send({
                method: "session/update",
                params: {
                    sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: reply },
                    },
                },
            });
            activePromptId = null;
            send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
            return;
        }
        return;
    }

    if (msg.method === "initialize") {
        send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
        return;
    }

    if (msg.method === "session/new") {
        send({ id: msg.id, result: { sessionId, configOptions: makeConfigOptions() } });
        return;
    }

    if (msg.method === "session/resume") {
        sessionId = msg.params.sessionId;
        send({ id: msg.id, result: { sessionId, configOptions: makeConfigOptions() } });
        return;
    }

    if (msg.method === "session/set_config_option") {
        if (msg.params.configId === "model") currentModel = msg.params.value;
        if (msg.params.configId === "thought_level") currentEffort = msg.params.value;
        send({ id: msg.id, result: { configOptions: makeConfigOptions() } });
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
        const promptBlocks = msg.params.prompt || [];
        const text = promptBlocks.filter((b) => b.type === "text").map((b) => b.text).join("\\n");
        const imageCount = promptBlocks.filter((b) => b.type === "image").length;

        if (text === "__CRASH__") {
            process.stderr.write("simulated acp crash\\n");
            process.exit(2);
        }

        if (text === "__HANG__") {
            send({
                method: "session/update",
                params: {
                    sessionId,
                    update: {
                        sessionUpdate: "tool_call",
                        toolCallId: "tc-hang",
                        name: "run_command",
                        status: "in_progress",
                        rawInput: { CommandLine: "sleep 60" },
                    },
                },
            });
            return;
        }

        if (text === "__ASK__") {
            pendingElicitation = { reqId: "e-1", promptId: msg.id };
            send({
                id: "e-1",
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
                                title: "1 + 1 = ?",
                                oneOf: [
                                    { const: "1", title: "2" },
                                    { const: "2", title: "3" },
                                ],
                            },
                            q1_other: { type: "string", title: "Other" },
                        },
                    },
                },
            });
            return;
        }

        if (text === "__PERM__") {
            pendingPermission = { reqId: "p-1", promptId: msg.id };
            send({
                id: "p-1",
                method: "session/request_permission",
                params: {
                    sessionId,
                    toolCall: { toolCallId: "tc-perm", title: "Execute ls" },
                    options: [
                        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
                        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
                    ],
                },
            });
            return;
        }

        send({
            method: "session/update",
            params: {
                sessionId,
                update: {
                    sessionUpdate: "tool_call",
                    toolCallId: "tc-read",
                    name: "read_file",
                    status: "completed",
                    rawInput: { Path: "README.md" },
                },
            },
        });

        const reply = "pid=" + process.pid + " sid=" + sessionId + " model=" + currentModel + " effort=" + currentEffort + " imgs=" + imageCount + " echo=" + text;
        send({
            method: "session/update",
            params: {
                sessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.slice(0, 12) } },
            },
        });
        send({
            method: "session/update",
            params: {
                sessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.slice(12) } },
            },
        });
        activePromptId = null;
        send({ id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 15, outputTokens: 8, totalTokens: 23 } } });
    }
});
`;

    await writeFile(scriptPath, source, "utf8");
    await chmod(scriptPath, 0o755);
    return { scriptPath, logPath };
}

test("AgyPersistentRunner 通过 zshrc 函数 a 启动 ACP，支持免重启切换模型、问卷回调与权限回调", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-acp-runner-"));
    const { scriptPath, logPath } = await createMockAcpScript(root);
    const rcFile = join(root, ".zshrc");
    await writeFile(
        rcFile,
        `a() {\n  echo "✅ 终端代理已开启，HTTP/HTTPS Proxy: http://127.0.0.1:7897"\n  "${scriptPath}" --dangerously-skip-permissions "$@"\n}\n`,
        "utf8",
    );

    const runner = new AgyPersistentRunner({
        cwd: root,
        config: {
            command: "a",
            launchMode: "auto",
            model: "gemini-4-neon",
            effort: "high",
            extraArgs: [],
            syncSummaryToMainModel: true,
        },
        probeOptions: {
            rcFile,
            env: { ...process.env, HOME: root, MOCK_AGY_LOG: logPath },
        },
    });

    try {
        const first = await runner.sendTurn("第一轮你好");
        assert.equal(first.status, "SUCCESS");
        assert.ok(first.response.includes("model=gemini-4-neon effort=high"));
        assert.ok(first.preambleLines?.some((line) => line.includes("终端代理已开启")));
        assert.equal(first.toolSteps[0]?.name, "read_file");

        // 仅切换模型与思考级别：应通过 session/set_config_option 实时生效，不重启子进程！
        await runner.reconfigure({
            command: "a",
            launchMode: "auto",
            model: "gemini-3.8-flash",
            effort: "low",
            extraArgs: [],
            syncSummaryToMainModel: true,
        });

        const asked = await runner.sendTurn("__ASK__", {
            onElicitation: async (req) => {
                assert.equal(req.questions.length, 1);
                assert.equal(req.questions[0]?.title, "1 + 1 = ?");
                return { action: "accept", content: { q1: "1" } };
            },
        });
        assert.equal(asked.status, "SUCCESS");
        assert.ok(asked.response.includes('"q1":"1"'));
        assert.ok(asked.response.includes("model=gemini-3.8-flash effort=low"));

        const perm = await runner.sendTurn("__PERM__", {
            onPermission: async (req) => {
                assert.equal(req.title, "Execute ls");
                return { outcome: { outcome: "selected", optionId: "allow_once" } };
            },
        });
        assert.equal(perm.status, "SUCCESS");
        assert.ok(perm.response.includes("allow_once"));

        const invocations = (await readFile(logPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { pid: number; args: string[] });
        assert.equal(invocations.length, 1, "多轮对话及切换模型均应复用同一常驻 ACP 进程");
        assert.ok(invocations[0]?.args.includes("acp"));
        assert.ok(invocations[0]?.args.includes("--dangerously-skip-permissions"));
    } finally {
        await runner.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("AgyPersistentRunner 支持优雅 session/cancel（不杀进程）及崩溃后 session/resume 自动续接", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-acp-resume-"));
    const { scriptPath, logPath } = await createMockAcpScript(root);

    const runner = new AgyPersistentRunner({
        cwd: root,
        config: {
            command: scriptPath,
            launchMode: "direct",
            extraArgs: [],
            syncSummaryToMainModel: true,
        },
        probeOptions: {
            env: { ...process.env, MOCK_AGY_LOG: logPath },
        },
        cancelGraceTimeoutMs: 500,
    });

    try {
        const turn1 = await runner.sendTurn("建立会话", {
            images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        });
        assert.equal(turn1.status, "SUCCESS");
        assert.ok(turn1.response.includes("imgs=1"));
        const sid = turn1.conversationId;
        assert.ok(sid);

        // 优雅取消应通过 session/cancel 结束本轮且不杀常驻进程。
        const cancelPromise = runner.sendTurn("__HANG__", {
            onProgress: (progress) => {
                if (progress.phase === "tool") runner.cancelCurrentTurn();
            },
        });
        const cancelled = await cancelPromise;
        assert.equal(cancelled.cancelled, true);
        assert.equal(runner.getStatus().runningProcess, true, "优雅取消后常驻 ACP 进程应保持存活");

        // 模拟崩溃后下一轮应自动拉起新进程并通过 session/resume 恢复同一 sessionId。
        const crashed = await runner.sendTurn("__CRASH__");
        assert.equal(crashed.status, "ERROR");
        assert.equal(runner.currentConversationId, sid);

        const resumed = await runner.sendTurn("崩溃后继续");
        assert.equal(resumed.status, "SUCCESS");
        assert.equal(resumed.conversationId, sid);
        assert.ok(resumed.response.includes(`sid=${sid}`));

        const invocations = (await readFile(logPath, "utf8"))
            .trim()
            .split("\n");
        assert.equal(invocations.length, 2, "取消不重启进程，仅崩溃后重启一次");
    } finally {
        await runner.close();
        await rm(root, { recursive: true, force: true });
    }
});

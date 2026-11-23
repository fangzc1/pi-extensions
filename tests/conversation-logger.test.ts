import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import conversationLogger from "../.pi/extensions/conversation-logger.ts";

const extensionPath = new URL("../.pi/extensions/conversation-logger.ts", import.meta.url);

test("对话日志扩展入口文件存在", () => {
    assert.equal(existsSync(extensionPath), true);
});

const activeRegistrations: Array<Map<string, (...args: any[]) => unknown>> = [];

test.afterEach(async () => {
    for (const handlers of activeRegistrations.splice(0)) {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, {});
    }
});

function registerExtension() {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
        on(name: string, handler: (...args: any[]) => unknown) {
            handlers.set(name, handler);
        },
    };
    conversationLogger(pi as never);
    activeRegistrations.push(handlers);
    return handlers;
}

test("注册 turn_end 事件处理器", () => {
    const handlers = registerExtension();
    assert.equal(typeof handlers.get("turn_end"), "function");
});

test("工具调用中的中间响应不保存日志", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conversation-logger-"));
    try {
        const handler = registerExtension().get("turn_end");
        await handler?.(
            {
                type: "turn_end",
                turnIndex: 0,
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "我先读取文件。" }],
                    stopReason: "toolUse",
                    timestamp: Date.now(),
                },
                toolResults: [],
            },
            {
                cwd,
                hasUI: false,
                sessionManager: {
                    getBranch: () => [
                        {
                            type: "message",
                            message: { role: "user", content: "检查项目", timestamp: Date.now() - 1 },
                        },
                    ],
                },
            },
        );

        assert.equal(existsSync(join(cwd, ".pi", "logs")), false);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("完整对话结束后保存会话元数据、用户和助手纯文本", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conversation-logger-"));
    try {
        const handler = registerExtension().get("turn_end");
        const userMessage = {
            role: "user",
            content: [{ type: "text", text: "请总结项目" }],
            timestamp: Date.parse("2026-07-30T03:17:41.000Z"),
        };
        const assistantMessage = {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "内部思考" },
                { type: "text", text: "项目总结完成。" },
                { type: "toolCall", id: "call-1", name: "read", arguments: {} },
            ],
            stopReason: "stop",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            thinkingLevel: "high",
            timestamp: Date.parse("2026-07-30T03:17:48.000Z"),
        };

        await handler?.(
            { type: "turn_end", turnIndex: 0, message: assistantMessage, toolResults: [] },
            {
                cwd,
                hasUI: false,
                model: { provider: "virtual", id: "auto" },
                thinkingLevel: "low",
                sessionManager: {
                    getSessionId: () => "session-123",
                    getBranch: () => [{ type: "message", message: userMessage }],
                },
            },
        );

        const logDir = join(cwd, ".pi", "logs");
        const files = existsSync(logDir) ? await readdir(logDir) : [];
        assert.equal(files.length, 1);
        const markdown = await readFile(join(logDir, files[0]), "utf8");
        assert.ok(
            markdown.includes(`\n\n**Session ID**: session-123\n\n**Pi Home 目录**: ${getAgentDir()}\n\n`),
        );
        assert.match(markdown, /\*\*模型\*\*: anthropic\/claude-sonnet-4-5/);
        assert.match(markdown, /\*\*思考级别\*\*: high/);
        assert.match(markdown, /## 👤 用户\n\n请总结项目/);
        assert.match(markdown, /## 🤖 助手\n\n项目总结完成。/);
        assert.doesNotMatch(markdown, /内部思考|call-1/);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("响应缺少模型元数据时记录会话配置，并随每轮配置变化", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conversation-logger-"));
    try {
        const handler = registerExtension().get("turn_end");
        let userTimestamp = 1;
        const ctx = {
            cwd,
            hasUI: false,
            model: { provider: "openai", id: "gpt-5" },
            thinkingLevel: "off",
            sessionManager: {
                getSessionId: () => "session-fallback",
                getBranch: () => [{
                    type: "message",
                    message: { role: "user", content: "继续", timestamp: userTimestamp },
                }],
            },
        };
        for (const level of ["off", "xhigh"]) {
            ctx.thinkingLevel = level;
            ctx.model.id = level === "off" ? "gpt-5" : "gpt-5-pro";
            await handler?.({
                type: "turn_end",
                message: { role: "assistant", content: "完成。", stopReason: "stop", timestamp: userTimestamp },
            }, ctx);
            userTimestamp += 1;
        }

        const logDir = join(cwd, ".pi", "logs");
        const files = await readdir(logDir);
        assert.equal(files.length, 2);
        const logs = await Promise.all(files.map((file) => readFile(join(logDir, file), "utf8")));
        assert.ok(logs.some((log) => log.includes("**模型**: openai/gpt-5\n")
            && log.includes("**思考级别**: off")));
        assert.ok(logs.some((log) => log.includes("**模型**: openai/gpt-5-pro\n")
            && log.includes("**思考级别**: xhigh")));
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("文件写入失败时提示警告且不打断对话", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-conversation-logger-"));
    try {
        const invalidCwd = join(tempDir, "not-a-directory");
        await writeFile(invalidCwd, "file", "utf8");
        const warnings: Array<{ message: string; level: string }> = [];
        const handler = registerExtension().get("turn_end");

        await assert.doesNotReject(() =>
            handler?.(
                {
                    type: "turn_end",
                    turnIndex: 0,
                    message: {
                        role: "assistant",
                        content: "已完成。",
                        stopReason: "stop",
                        timestamp: Date.now(),
                    },
                    toolResults: [],
                },
                {
                    cwd: invalidCwd,
                    hasUI: true,
                    ui: {
                        notify: (message: string, level: string) => warnings.push({ message, level }),
                    },
                    sessionManager: {
                        getSessionId: () => "session-456",
                        getBranch: () => [
                            {
                                type: "message",
                                message: { role: "user", content: "执行任务", timestamp: 1 },
                            },
                        ],
                    },
                },
            ) as Promise<void>,
        );
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].level, "warning");
        assert.match(warnings[0].message, /保存对话日志失败/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("同一秒内内容相同的两轮对话分别保存", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conversation-logger-"));
    try {
        const handler = registerExtension().get("turn_end");
        const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "好的。" }],
            stopReason: "stop",
            timestamp: Date.parse("2026-07-30T03:17:48.000Z"),
        };
        let userTimestamp = 1;
        const ctx = {
            cwd,
            hasUI: false,
            sessionManager: {
                getSessionId: () => "session-789",
                getBranch: () => [
                    {
                        type: "message",
                        message: { role: "user", content: "继续", timestamp: userTimestamp },
                    },
                ],
            },
        };

        await handler?.({ type: "turn_end", turnIndex: 0, message: assistantMessage, toolResults: [] }, ctx);
        userTimestamp = 2;
        await handler?.({ type: "turn_end", turnIndex: 0, message: assistantMessage, toolResults: [] }, ctx);

        const files = await readdir(join(cwd, ".pi", "logs"));
        assert.equal(files.length, 2);
        const markdown = await readFile(join(cwd, ".pi", "logs", files[0]), "utf8");
        assert.match(markdown, /\*\*模型\*\*: 未知/);
        assert.match(markdown, /\*\*思考级别\*\*: 未知/);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

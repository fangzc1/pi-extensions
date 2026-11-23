import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import rewindClaude from "./index.ts";

test("工具拦截：检查点创建失败时仅告警且不阻断 write", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-fail-open-"));
    const cwd = join(root, "project");
    await mkdir(cwd);

    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    const notifications: Array<{ message: string; level: string }> = [];
    const pi = {
        on(event: string, handler: (...args: any[]) => Promise<unknown>) {
            handlers.set(event, handler);
        },
        registerCommand() {},
    };
    const userMessage = { role: "user", content: "写入文件", timestamp: 123 };
    const ctx = {
        cwd,
        mode: "print",
        sessionManager: {
            getSessionFile: () => join(root, "session.jsonl"),
            getSessionId: () => "session-fail-open",
            getBranch: () => [{ type: "message", id: "user-1", message: userMessage }],
        },
        ui: {
            notify(message: string, level: string) {
                notifications.push({ message, level });
            },
        },
    };

    try {
        rewindClaude(pi as any);
        await handlers.get("session_start")?.({ reason: "startup" }, ctx);
        await handlers.get("message_end")?.({ message: userMessage }, ctx);

        // 项目根目录不是可快照文件，用它稳定触发 CheckpointStore 错误。
        const result = await handlers.get("tool_call")?.({
            toolName: "write",
            toolCallId: "tool-1",
            input: { path: cwd, content: "irrelevant" },
        }, ctx);

        assert.equal(result, undefined);
        assert.equal(notifications.at(-1)?.level, "warning");
        assert.match(notifications.at(-1)?.message ?? "", /checkpoint/i);
    } finally {
        await handlers.get("session_shutdown")?.({}, ctx);
        await rm(root, { recursive: true, force: true });
    }
});

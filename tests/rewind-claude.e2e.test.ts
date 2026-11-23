import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import rewindClaude from "../.pi/extensions/rewind-claude/index.ts";

const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    dim: (text: string) => text,
};

async function runRestoreBothScenario(forkOutcome: "success" | "cancel" | "throw"): Promise<{
    content: string;
    forks: Array<{ entryId: string; options: object }>;
    notifications: Array<{ message: string; level: string }>;
    customCalls: number;
    waitedForIdle: number;
}> {
    const root = await mkdtemp(join(tmpdir(), "rewind-claude-e2e-"));
    const cwd = join(root, "project");
    const sessionFile = join(root, "session.jsonl");
    const targetFile = join(cwd, "demo.txt");
    await mkdir(cwd);
    await writeFile(targetFile, "before\n", "utf8");

    const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<unknown>>>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const notifications: Array<{ message: string; level: string }> = [];
    const forks: Array<{ entryId: string; options: object }> = [];
    const branch: any[] = [];
    let customCalls = 0;
    let waitedForIdle = 0;

    const pi = {
        on(name: string, handler: (event: any, ctx: any) => Promise<unknown>) {
            const registered = handlers.get(name) ?? [];
            registered.push(handler);
            handlers.set(name, registered);
        },
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
            commands.set(name, command);
        },
        getThinkingLevel: () => "high",
        setThinkingLevel: () => {},
        setModel: async () => true,
        sendUserMessage: () => {},
    };
    const ctx = {
        cwd,
        mode: "tui",
        model: { provider: "test", id: "test-model" },
        modelRegistry: { find: () => undefined },
        sessionManager: {
            getSessionFile: () => sessionFile,
            getSessionId: () => "e2e-session",
            getBranch: () => branch,
        },
        isIdle: () => true,
        waitForIdle: async () => { waitedForIdle++; },
        fork: async (entryId: string, options: object) => {
            forks.push({ entryId, options });
            if (forkOutcome === "throw") throw new Error("fork unavailable");
            return { cancelled: forkOutcome === "cancel" };
        },
        navigateTree: async () => {},
        compact: () => {},
        ui: {
            getEditorComponent: () => undefined,
            setEditorComponent: () => {},
            notify: (message: string, level: string) => notifications.push({ message, level }),
            custom: async (factory: (tui: object, theme: object, keybindings: object, done: (value: unknown) => void) => any) => {
                customCalls++;
                return new Promise((resolve) => {
                    const component = factory({ requestRender: () => {} }, theme, {}, resolve);
                    // 回退点页默认选中 current，先上移到最新 Prompt；确认页默认选中联合恢复。
                    if (customCalls === 1) component.handleInput("\u001b[A");
                    component.handleInput("\r");
                });
            },
        },
    };

    async function emit(name: string, event: object): Promise<unknown[]> {
        const results = [];
        for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
        return results;
    }

    try {
        rewindClaude(pi as any);
        assert.ok(commands.has("rewind-claude"), "扩展应注册 /rewind-claude 命令");
        await emit("session_start", { reason: "new" });

        const userMessage = { role: "user", content: "修改 demo.txt", timestamp: 1000 };
        await emit("message_end", { message: userMessage });
        branch.push({ type: "message", id: "user-entry-1", message: userMessage });

        const toolEvent = {
            toolName: "write",
            toolCallId: "tool-call-1",
            input: { path: targetFile, content: "after\n" },
        };
        assert.deepEqual(await emit("tool_call", toolEvent), [undefined]);
        await writeFile(targetFile, "after\n", "utf8");
        await emit("tool_result", { ...toolEvent, isError: false });

        const manifest = JSON.parse(await readFile(`${sessionFile}.rewind-claude/manifest.json`, "utf8"));
        assert.equal(manifest.checkpoints[0].userEntryId, "user-entry-1");
        assert.deepEqual(manifest.checkpoints[0].changes, [
            { path: "demo.txt", additions: 1, deletions: 1 },
        ]);

        await commands.get("rewind-claude")!.handler("", ctx);
        return {
            content: await readFile(targetFile, "utf8"),
            forks,
            notifications,
            customCalls,
            waitedForIdle,
        };
    } finally {
        await emit("session_shutdown", {});
        await rm(root, { recursive: true, force: true });
    }
}

test("端到端：扩展从 Prompt 检查点追踪 write，并通过菜单恢复代码与 Fork 会话", async () => {
    const result = await runRestoreBothScenario("success");
    assert.equal(result.content, "before\n");
    assert.deepEqual(result.forks, [
        { entryId: "user-entry-1", options: { position: "before" } },
    ]);
    assert.equal(result.waitedForIdle, 1);
    assert.equal(result.customCalls, 2);
    assert.equal(result.notifications.some(({ level }) => level === "error"), false);
});

test("端到端：联合恢复的 Fork 被取消时回滚代码", async () => {
    const result = await runRestoreBothScenario("cancel");
    assert.equal(result.content, "after\n");
    assert.ok(result.notifications.some(({ message, level }) =>
        message.includes("fork was cancelled") && level === "error"));
});

test("端到端：联合恢复的 Fork 抛错时回滚代码", async () => {
    const result = await runRestoreBothScenario("throw");
    assert.equal(result.content, "after\n");
    assert.ok(result.notifications.some(({ message, level }) =>
        message.includes("fork unavailable") && level === "error"));
});

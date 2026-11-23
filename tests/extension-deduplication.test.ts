import assert from "node:assert/strict";
import test from "node:test";

import projectClaudeStyle from "../.pi/extensions/claude-style/index.ts";
import projectConversationLogger from "../.pi/extensions/conversation-logger.ts";
import projectModelThinkingMemory from "../.pi/extensions/model-thinking-memory.ts";
import projectResponseTimer from "../.pi/extensions/response-timer.ts";
import projectRewindClaude from "../.pi/extensions/rewind-claude/index.ts";

type ExtensionFactory = (pi: any) => void;
type Handler = (...args: any[]) => unknown;

class FakePi {
    registrationCount = 0;
    readonly handlers = new Map<string, Handler[]>();

    readonly api = {
        on: (event: string, handler: Handler) => {
            this.registrationCount++;
            const handlers = this.handlers.get(event) ?? [];
            handlers.push(handler);
            this.handlers.set(event, handlers);
        },
        registerTool: () => { this.registrationCount++; },
        registerToolRenderer: () => { this.registrationCount++; },
        registerCommand: () => { this.registrationCount++; },
        registerEntryRenderer: () => { this.registrationCount++; },
    };

    async shutdown(): Promise<void> {
        for (const handler of this.handlers.get("session_shutdown") ?? []) {
            await handler({ type: "session_shutdown", reason: "quit" }, {});
        }
    }
}

async function loadDuplicateExtension(path: string): Promise<ExtensionFactory> {
    // Query string 强制创建独立模块实例，模拟用户级与项目级从不同路径分别加载。
    const url = new URL(`../.pi/extensions/${path}`, import.meta.url);
    url.searchParams.set("scope", "user");
    const module = await import(url.href);
    return module.default as ExtensionFactory;
}

async function assertOnlyFirstRegisters(first: ExtensionFactory, second: ExtensionFactory): Promise<void> {
    const firstPi = new FakePi();
    const secondPi = new FakePi();
    first(firstPi.api);
    second(secondPi.api);

    assert.ok(firstPi.registrationCount > 0, "先加载的扩展应完成注册");
    assert.equal(secondPi.registrationCount, 0, "后加载的重复扩展不应注册任何内容");
    await firstPi.shutdown();
    await secondPi.shutdown();
}

const extensions: Array<{
    name: string;
    userPath: string;
    project: ExtensionFactory;
}> = [
    { name: "claude-style", userPath: "claude-style/index.ts", project: projectClaudeStyle },
    { name: "conversation-logger", userPath: "conversation-logger.ts", project: projectConversationLogger },
    { name: "model-thinking-memory", userPath: "model-thinking-memory.ts", project: projectModelThinkingMemory },
    { name: "response-timer", userPath: "response-timer.ts", project: projectResponseTimer },
    { name: "rewind-claude", userPath: "rewind-claude/index.ts", project: projectRewindClaude },
];

for (const extension of extensions) {
    test(`${extension.name}：用户级与项目级同时存在时只注册先加载的一份`, async () => {
        const user = await loadDuplicateExtension(extension.userPath);
        await assertOnlyFirstRegisters(extension.project, user);
        await assertOnlyFirstRegisters(user, extension.project);
    });
}

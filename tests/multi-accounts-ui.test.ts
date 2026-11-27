import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../.pi/extensions/multi-accounts/index.ts";
import { AccountStore } from "../.pi/extensions/multi-accounts/store.ts";

test("账号入口无需手工导入就默认显示已有 Provider 当前账号", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-accounts-ui-"));
    try {
        const store = new AccountStore(directory);
        await writeFile(store.authPath, JSON.stringify({ example: { type: "api_key", key: "fake-secret" } }));
        let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
        const pi = { on: () => {}, registerCommand: (name: string, command: { handler: typeof handler }) => { assert.equal(name, "multi-accounts"); handler = command.handler; } } as unknown as ExtensionAPI;
        extension(pi, store);
        const screens: string[][] = [];
        const ctx = {
            hasUI: true,
            ui: {
                select: async (_title: string, choices: string[]) => { screens.push(choices); return undefined; },
                notify: () => assert.fail("不应产生错误通知"),
            },
            modelRegistry: {
                getModelsOfType: () => [],
                getAll: () => [{ provider: "example" }],
                getProvider: () => ({ name: "Example", auth: {} }),
                getProviderDisplayName: () => "Example",
            },
        } as unknown as ExtensionCommandContext;
        await handler!("", ctx);
        assert.equal(screens.length, 1);
        assert.ok(screens[0].some(row => row.includes("现有登录账号") && row.includes("当前")));
        assert.ok(screens[0].some(row => row.includes("选择 / 添加 Provider")));
        assert.ok(!JSON.stringify(screens).includes("fake-secret"));
    } finally { await rm(directory, { recursive: true, force: true }); }
});

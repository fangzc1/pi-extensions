import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../.pi/extensions/multi-accounts/index.ts";
import { AccountStore } from "../.pi/extensions/multi-accounts/store.ts";

for (const mode of ["save", "cancel", "invalid", "classifier"] as const) {
    test(`管理流程回归：${mode}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "pi-accounts-login-"));
        try {
            const store = new AccountStore(directory);
            if (mode !== "classifier") await writeFile(store.authPath, JSON.stringify({ example: { type: "api_key", key: "fake-old" } }));
            let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
            const pi = { on: () => {}, registerCommand: (_: string, command: { handler: typeof handler }) => { handler = command.handler; } } as unknown as ExtensionAPI;
            extension(pi, store);
            const screens: string[] = [];
            const errors: string[] = [];
            let selected = false;
            const ctx = {
                hasUI: true, mode: "tui",
                ui: {
                    input: async () => mode === "invalid" ? " " : "新增",
                    onTerminalInput: () => () => {},
                    notify: (message: string, level?: string) => { if (level === "error") errors.push(message); },
                    select: async (title: string, rows: string[]) => {
                        screens.push(title);
                        if (mode === "classifier") {
                            if (title === "Provider 账号管理") return rows.find(row => row.includes("添加 Provider"));
                            assert.ok(rows.some(row => row.includes("Example")));
                            return undefined;
                        }
                        if (!selected) { selected = true; return rows.find(row => row.includes("添加账号")); }
                        if (title === "账号已保存") return rows.find(row => row.includes("仅保存"));
                        return undefined;
                    },
                },
                modelRegistry: {
                    getAll: () => mode === "classifier" ? [] : [{ provider: "example" }],
                    getModelsOfType: (type: string) => type === "classifier" ? [{ provider: "example" }] : [],
                    getProviderDisplayName: () => "Example",
                    getProvider: () => ({ id: "example", name: "Example", auth: { apiKey: { name: "API Key", login: async () => {
                        if (mode === "cancel") throw Object.assign(new Error("cancel"), { name: "AbortError" });
                        return { type: "api_key", key: "fake-new" };
                    } } } }),
                },
            } as unknown as ExtensionCommandContext;
            // classifier 页退出后直接终止测试对话，防止反复选择添加。
            if (mode === "classifier") {
                let calls = 0;
                const select = ctx.ui.select;
                ctx.ui.select = async (...args) => ++calls > 2 ? undefined : select(...args);
            }
            await handler!("", ctx);
            if (mode === "save") assert.ok(screens.includes("账号已保存"));
            if (mode === "cancel" || mode === "invalid") {
                assert.ok(screens.filter(title => title.includes("全局账号")).length >= 2);
                assert.equal(errors.length, 0);
            }
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
}

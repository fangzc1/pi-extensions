import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import test from "node:test";

test("防重逻辑必须位于原有扩展内，不保留独立 guard 模块", () => {
    assert.equal(
        existsSync(new URL("../.pi/extensions/claude-style/extension-guard.ts", import.meta.url)),
        false,
    );
});

test("extensions 根目录下的 TypeScript 文件都必须导出 Pi factory", async () => {
    const extensionRoot = new URL("../.pi/extensions/", import.meta.url);
    const entries = await readdir(extensionRoot, { withFileTypes: true });
    const rootTypeScriptFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name)
        .sort();

    for (const fileName of rootTypeScriptFiles) {
        const module = await import(new URL(fileName, extensionRoot).href);
        assert.equal(
            typeof module.default,
            "function",
            `${fileName} 必须默认导出 Pi extension factory`,
        );
    }
});

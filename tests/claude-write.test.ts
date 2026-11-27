import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createClaudeWriteToolDefinition } from "../.pi/extensions/claude-style/index.ts";
import {
    ClaudeWriteView,
    createWriteViewModel,
    type ClaudeWriteTheme,
} from "../.pi/extensions/claude-style/write-view.ts";

// Pi 的 highlightCode 读取模块级全局主题，未初始化会抛 "Theme not initialized"。
// 测试进程独立，这里初始化为内置主题即可，注入的 plainTheme 仍负责其余着色。
initTheme();

const plainTheme: ClaudeWriteTheme = {
    fg: (_color, text) => text,
    bold: (text) => text,
};

function plain(lines: string[]): string[] {
    return lines.map((line) => stripTerminalSequences(line));
}

test("折叠态仅显示去重路径后的统计行，展开态展示带行号的完整代码", () => {
    const model = createWriteViewModel(
        "/workspace/src/hello.ts",
        "export function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
        "success",
        undefined,
        "/workspace",
    );
    const view = new ClaudeWriteView(model, plainTheme);
    view.setExpandHint("ctrl+o to expand");

    const collapsed = plain(view.render(100));
    assert.deepEqual(collapsed, [
        "⏺ write(src/hello.ts)",
        "  ⎿  Wrote 3 lines (ctrl+o to expand)",
    ]);

    view.setExpanded(true);
    const expanded = plain(view.render(100));
    assert.equal(expanded[0], "⏺ write(src/hello.ts)");
    assert.equal(expanded[1], "  ⎿  Wrote 3 lines");
    assert.match(expanded[2] ?? "", /^\s+1 export function hello/);
    assert.match(expanded[3] ?? "", /^\s+2   return/);
    assert.match(expanded[4] ?? "", /^\s+3 }/);
    assert.equal(expanded.some((line) => /[┌┐└┘─]/u.test(line)), false);
});

test("预览态与空文件均不铺开正文，展开长文件展示全部行", () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const preview = new ClaudeWriteView(
        createWriteViewModel("notes.txt", content, "preview"),
        plainTheme,
    );
    assert.deepEqual(plain(preview.render(80)), [
        "⏺ write(notes.txt)",
        "  ⎿  Writing 12 lines…",
    ]);

    const empty = new ClaudeWriteView(createWriteViewModel("empty.txt", "", "success"), plainTheme);
    assert.deepEqual(plain(empty.render(80)), [
        "⏺ write(empty.txt)",
        "  ⎿  Wrote 0 lines",
    ]);

    const view = new ClaudeWriteView(createWriteViewModel("notes.txt", content, "success"), plainTheme);
    view.setExpanded(true);
    const expanded = plain(view.render(80));
    assert.ok(expanded.some((line) => line.includes("line 1")));
    assert.ok(expanded.some((line) => line.includes("line 12")));
});

test("错误状态保留 Write 标题并显示原始错误", () => {
    const model = createWriteViewModel("src/hello.ts", "", "error", "Permission denied");
    const lines = plain(new ClaudeWriteView(model, plainTheme).render(80));

    assert.equal(lines[0], "⏺ write(src/hello.ts)");
    assert.equal(lines[1], "  ⎿  Permission denied");
});

test("ANSI、中文和 emoji 下渲染行不超过终端宽度", () => {
    const ansiTheme: ClaudeWriteTheme = {
        fg: (_color, text) => `\u001b[32m${text}\u001b[39m`,
        bold: (text) => `\u001b[1m${text}\u001b[22m`,
    };
    const content = `export const message = "${"你好🙂".repeat(30)}";`;
    const view = new ClaudeWriteView(createWriteViewModel("很长的文件名.ts", content, "success"), ansiTheme);
    view.setExpanded(true);

    assert.ok(view.render(60).every((line) => visibleWidth(line) <= 60));
});

test("覆盖 write renderer 时保留 Pi 原生写入结果", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-write-"));
    try {
        const tool = createClaudeWriteToolDefinition(directory);
        const result = await tool.execute(
            "call-1",
            { path: "nested/hello.ts", content: "export const hello = true;\n" },
            undefined,
            undefined,
            undefined as never,
        );

        assert.equal(tool.name, "write");
        assert.equal(tool.renderShell, "self");
        assert.equal(typeof tool.renderCall, "function");
        assert.equal(typeof tool.renderResult, "function");
        assert.equal(await readFile(join(directory, "nested/hello.ts"), "utf8"), "export const hello = true;\n");
        assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Successfully wrote/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createClaudeWriteToolDefinition } from "../.pi/extensions/claude-style/index.ts";
import {
    ClaudeWriteView,
    createWriteViewModel,
    type ClaudeWriteTheme,
} from "../.pi/extensions/claude-style/write-view.ts";

const plainTheme: ClaudeWriteTheme = {
    fg: (_color, text) => text,
    bold: (text) => text,
};

function plain(lines: string[]): string[] {
    return lines.map((line) => stripTerminalSequences(line));
}

test("使用 Claude Code 实测结构展示新建文件", () => {
    const model = createWriteViewModel(
        "src/hello.ts",
        "export function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
        "success",
    );
    const view = new ClaudeWriteView(model, plainTheme);
    const lines = plain(view.render(100));

    assert.equal(lines[0], "⏺ write(src/hello.ts)");
    assert.equal(lines[1], "  ⎿  Wrote 3 lines to src/hello.ts");
    assert.match(lines[2] ?? "", /^\s+1 export function hello/);
    assert.match(lines[3] ?? "", /^\s+2   return/);
    assert.match(lines[4] ?? "", /^\s+3 }/);
    assert.equal(lines.some((line) => /[┌┐└┘─]/u.test(line)), false);
});

test("默认折叠十行，展开后展示全部内容", () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const view = new ClaudeWriteView(createWriteViewModel("notes.txt", content, "success"), plainTheme);

    const collapsed = plain(view.render(80));
    assert.ok(collapsed.some((line) => line.includes("2 more lines")));
    assert.equal(collapsed.some((line) => line.includes("line 12")), false);

    view.setExpanded(true);
    const expanded = plain(view.render(80));
    assert.equal(expanded.some((line) => line.includes("2 more lines")), false);
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

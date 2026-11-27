import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createClaudeEditToolDefinition } from "../.pi/extensions/claude-style/index.ts";
import {
    ClaudeEditView,
    createClaudeEditModel,
    type ClaudeEditTheme,
} from "../.pi/extensions/claude-style/edit-view.ts";

const plainTheme: ClaudeEditTheme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    inverse: (text) => text,
};

const plainHighlighter = (code: string): string[] => code.split("\n");

function plain(lines: string[]): string[] {
    return lines.map((line) => stripTerminalSequences(line));
}

const HTML_DIFF = [
    "     ...",
    " 21          }",
    " 22      </style>",
    " 23  </head>",
    " 24  <body>",
    "-25    <h1>Hello</h1>",
    "+25    <h1>Hello1</h1>",
    " 26  </body>",
    " 27  </html>",
].join("\n");

test("折叠态保留 2 行上下文，展开态恢复 3 行上下文并保持 unified Edit 结构", () => {
    const cwd = "/Users/test/project";
    const model = createClaudeEditModel(
        "/Users/test/project/index.html",
        HTML_DIFF,
        cwd,
        "success",
    );
    const view = new ClaudeEditView(model, plainTheme, plainHighlighter);

    // 折叠态仅保留前后 2 行上下文（23、24、26、27），去掉第 22 行。
    const collapsed = plain(view.render(100));
    assert.equal(collapsed[0], "⏺ edit(index.html)");
    assert.equal(collapsed[1], "  ⎿  Added 1 line, removed 1 line");
    assert.equal(collapsed.some((line) => line.trim() === "..."), false);
    assert.equal(collapsed.some((line) => /^\s*22\s/.test(line)), false);
    assert.ok(collapsed.some((line) => /^\s*23\s+<\/head>/.test(line)));
    assert.ok(collapsed.some((line) => /^\s*25 -\s+<h1>Hello<\/h1>/.test(line)));
    assert.ok(collapsed.some((line) => /^\s*25 \+\s+<h1>Hello1<\/h1>/.test(line)));
    assert.equal(collapsed.some((line) => line.includes("Before") || line.includes("│ After")), false);
    assert.equal(collapsed.some((line) => /[┌┐└┘─]/u.test(line)), false);

    // 展开态恢复 3 行上下文（保留第 22 行）。
    view.setExpanded(true);
    const expanded = plain(view.render(100));
    assert.ok(expanded.some((line) => /^\s*22\s+<\/style>/.test(line)));
    assert.equal(expanded.some((line) => /^\s*21\s/.test(line)), false);
});

test("大块 edit 折叠态限制最多 12 行 diff，展开后显示全部行", () => {
    const largeDiff = Array.from({ length: 18 }, (_, index) => {
        const lineNo = index + 1;
        return `+${lineNo} const line${lineNo} = ${lineNo};`;
    }).join("\n");
    const model = createClaudeEditModel("src/big.ts", largeDiff, "/project", "success");
    const view = new ClaudeEditView(model, plainTheme, plainHighlighter);
    view.setExpandHint("ctrl+o to expand");

    const collapsed = plain(view.render(100));
    // 标题 1 行 + 统计 1 行 + 12 行 diff + 1 行折叠提示 = 15 行。
    assert.equal(collapsed.length, 15);
    assert.equal(collapsed.at(-1), "     … (6 more lines, ctrl+o to expand)");
    assert.equal(collapsed.some((line) => line.includes("line18")), false);

    view.setExpanded(true);
    const expanded = plain(view.render(100));
    assert.equal(expanded.length, 20);
    assert.ok(expanded.some((line) => line.includes("line18")));
    assert.equal(expanded.some((line) => line.includes("more lines")), false);
});

test("使用 Claude Code 截图中的精确 RGB 且 Diff 正文保持单色", () => {
    let highlightCalls = 0;
    const highlighter = (code: string): string[] => {
        highlightCalls++;
        return [`\u001b[34m${code}\u001b[39m`];
    };
    const model = createClaudeEditModel("index.html", HTML_DIFF, "/project", "success");
    const view = new ClaudeEditView(model, plainTheme, highlighter);
    const lines = view.render(100);
    const header = lines[0] ?? "";
    const context = lines.find((line) => stripTerminalSequences(line).trimStart().startsWith("23")) ?? "";
    const removed = lines.find((line) => stripTerminalSequences(line).includes("25 -")) ?? "";
    const added = lines.find((line) => stripTerminalSequences(line).includes("25 +")) ?? "";

    assert.match(header, /\u001b\[38;2;45;123;57m⏺/);
    assert.match(header, /\u001b\[38;2;88;110;117medit/);
    assert.match(context, /\u001b\[38;2;51;51;51m/);
    assert.match(removed, /\u001b\[48;2;255;220;221m/);
    assert.match(removed, /\u001b\[38;2;208;34;46m25 -/);
    assert.match(removed, /\u001b\[38;2;51;51;51m/);
    assert.match(removed, /\u001b\[48;2;255;199;199mHello\u001b\[48;2;255;220;221m/);
    assert.match(added, /\u001b\[48;2;221;255;221m/);
    assert.match(added, /\u001b\[38;2;37;138;62m25 \+/);
    assert.match(added, /\u001b\[48;2;179;255;179mHello1\u001b\[48;2;221;255;221m/);
    assert.equal(visibleWidth(removed), 100);
    assert.equal(visibleWidth(added), 100);
    assert.equal(highlightCalls, 0);
});

test("长路径、中文与 emoji 下所有行都不超过终端宽度", () => {
    const model = createClaudeEditModel(
        "/project/src/很长的目录/页面.html",
        `-25 <h1>${"你好🙂".repeat(30)}</h1>\n+25 <h1>完成</h1>`,
        "/project",
        "success",
    );
    const view = new ClaudeEditView(model, plainTheme, plainHighlighter);

    assert.ok(view.render(60).every((line) => visibleWidth(line) <= 60));
});

test("覆盖 edit renderer 时保留 Pi 原生文件修改结果并响应 expanded 切换", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-edit-"));
    const filePath = join(directory, "index.html");
    await writeFile(filePath, "<h1>Hello</h1>\n", "utf8");

    try {
        const tool = createClaudeEditToolDefinition(directory);
        const result = await tool.execute(
            "call-1",
            {
                path: "index.html",
                edits: [{ oldText: "<h1>Hello</h1>", newText: "<h1>Hello1</h1>" }],
            },
            undefined,
            undefined,
            undefined as never,
        );

        assert.equal(tool.name, "edit");
        assert.equal(typeof tool.renderCall, "function");
        assert.equal(typeof tool.renderResult, "function");
        assert.equal(await readFile(filePath, "utf8"), "<h1>Hello1</h1>\n");
        assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Successfully/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { createClaudeCodemodeToolRenderer } from "../.pi/extensions/claude-style/index.ts";
import {
    ClaudeCodemodeView,
    type CodemodeResult,
} from "../.pi/extensions/claude-style/codemode-view.ts";

/** 任何卡片式背景都会破坏 Claude Code 的无边框观感。 */
const BACKGROUND_ANSI = /\u001b\[(?:4[0-7]|10[0-7]|48(?:;[25];[^m]+)?)m/u;

initTheme();

const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => `**${text}**`,
};

function createContext(args: unknown, state: Record<string, unknown>, expanded = false) {
    return {
        args,
        state,
        expanded,
        lastComponent: undefined,
        isError: false,
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        showImages: false,
        toolCallId: "call-1",
        cwd: process.cwd(),
        invalidate() {},
        keyText: () => "ctrl+o",
        keyHint: (_id: string, description: string) => `ctrl+o ${description}`,
    };
}

function plain(lines: string[]): string[] {
    return lines.map((line) => stripTerminalSequences(line));
}

function successResult(output: string, details: CodemodeResult["details"]): CodemodeResult {
    return {
        content: [
            { type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
            ...(output ? [{ type: "text", text: output }] : []),
        ],
        details,
    };
}

function renderView(
    args: unknown,
    result: CodemodeResult | undefined,
    options: { expanded?: boolean; phase?: "pending" | "success" | "error" } = {},
): string[] {
    const view = new ClaudeCodemodeView(args, plainTheme as never);
    view.setExpandHint("ctrl+o to expand");
    view.setExpanded(options.expanded ?? false);
    if (!result) return plain(view.render(100));
    if (options.phase === "pending") view.setPending(result, options.expanded ?? false);
    else view.setResult(result, options.phase ?? "success", options.expanded ?? false);
    return plain(view.render(100));
}

test("codemode 渲染器只接管 codemode，其余工具交回 Pi 默认解析", () => {
    const resolver = createClaudeCodemodeToolRenderer();
    let forwarded: string[] = [];
    const next = (): undefined => {
        forwarded.push("next");
        return undefined;
    };

    const renderers = resolver("codemode", next);
    assert.ok(renderers?.renderCall && renderers.renderResult);
    assert.equal(renderers.renderShell, "self");
    assert.deepEqual(forwarded, []);

    assert.equal(resolver("read", next), undefined);
    assert.equal(resolver("mcp__tabby_mcp__query", next), undefined);
    assert.deepEqual(forwarded, ["next", "next"]);
});

test("折叠态标题聚合嵌套调用，隐藏成功子调用明细并保留失败子调用与尾部输出", () => {
    const args = {
        code: 'const files = await tools.find({ pattern: "**/*.ts" });\nconst count = files.length;\ntext(`count=${count}`);\n',
    };
    const lines = renderView(
        args,
        successResult("count=42", {
            calls: [
                { name: "find", args: '{"pattern":"**/*.ts"}', status: "ok", durationMs: 320 },
                { name: "read", args: '{"path":"src/a.ts"}', status: "ok", durationMs: 40 },
                { name: "read", args: '{"path":"src/b.ts"}', status: "error", durationMs: 1200, error: "ENOENT" },
            ],
        }),
    );

    assert.deepEqual(lines, [
        "⏺ **codemode**(find, read ×2) · 1.2s",
        "  ⎿  ✗ read 1.2s ENOENT",
        "     count=42",
    ]);
    for (const line of lines) {
        assert.equal(line.includes("\n"), false);
        assert.equal(BACKGROUND_ANSI.test(line), false);
    }
});

test("全部子调用成功且无输出时折叠为严格 1 行；有注释时优先用注释作为标题", () => {
    const withCalls = renderView(
        { code: "await tools.find({ pattern: '*.ts' });" },
        successResult("", {
            calls: [
                { name: "find", status: "ok", durationMs: 10 },
                { name: "read", status: "ok", durationMs: 12 },
                { name: "read", status: "ok", durationMs: 15 },
            ],
        }),
    );
    assert.deepEqual(withCalls, ["⏺ **codemode**(find, read ×2) · 1.2s"]);

    const withComment = renderView(
        { code: "// @options: {\"timeout\":30}\n// 统计测试文件数量\nstore('answer', 42);" },
        successResult("", { calls: [] }),
    );
    assert.deepEqual(withComment, ["⏺ **codemode**(统计测试文件数量) · 1.2s"]);

    const plainCode = renderView(
        { code: "store('answer', 42);" },
        successResult("", { calls: [] }),
    );
    assert.deepEqual(plainCode, ["⏺ **codemode**(store('answer', 42);) · 1.2s"]);
});

test("展开态展示完整脚本、全部嵌套调用参数与全部输出", () => {
    const code = 'const files = await tools.find({ pattern: "**/*.ts" });\nconst count = files.length;\ntext(`count=${count}`);\n';
    const output = ["line-01", "line-02"].join("\n");
    const expanded = renderView(
        { code },
        successResult(output, {
            calls: [{ name: "find", args: '{"pattern":"**/*.ts"}', status: "ok", durationMs: 320 }],
        }),
        { expanded: true },
    );

    assert.deepEqual(expanded.slice(0, 3), [
        '⏺ **codemode**(const files = await tools.find({ pattern: "**/*.ts" });',
        "     const count = files.length;",
        "     text(`count=${count}`);)",
    ]);
    assert.deepEqual(expanded.slice(3), [
        "  ⎿  Ran **1** tool call in 1.2s",
        '     ✓ find {"pattern":"**/*.ts"} 320ms',
        "     line-01",
        "     line-02",
    ]);
});

test("超过折叠预算的脚本输出按尾部 3 行保留并提示展开", () => {
    const output = Array.from({ length: 8 }, (_, index) => `output-${index + 1}`).join("\n");
    const collapsed = renderView(
        { code: "text('x');" },
        successResult(output, { calls: [{ name: "find", status: "ok" }] }),
    );
    const expanded = renderView(
        { code: "text('x');" },
        successResult(output, { calls: [{ name: "find", status: "ok" }] }),
        { expanded: true },
    );

    assert.deepEqual(collapsed, [
        "⏺ **codemode**(find) · 1.2s",
        "  ⎿  … (5 earlier lines, ctrl+o to expand)",
        "     output-6",
        "     output-7",
        "     output-8",
    ]);
    assert.equal(expanded.some((line) => line.includes("output-1")), true);
    assert.equal(expanded.at(-1), "     output-8");
    assert.equal(expanded.some((line) => line.includes("earlier lines")), false);
});

test("多次模型调用在折叠态仅保留总成本，单次成功调用不刷屏", () => {
    const single = renderView(
        { code: "text('x');" },
        successResult("", { calls: [{ name: "models.classify", status: "ok", cost: 0.0012 }] }),
    );
    const multiple = renderView(
        { code: "text('x');" },
        successResult("", {
            calls: [
                { name: "models.classify", status: "ok", cost: 0.0012 },
                { name: "models.generateImages", status: "ok", cost: 0.0018 },
            ],
        }),
    );

    assert.deepEqual(single, ["⏺ **codemode**(models.classify) · 1.2s"]);
    assert.deepEqual(multiple, [
        "⏺ **codemode**(models.classify, models.generateImages) · 1.2s",
        "  ⎿  Model calls: $0.0030",
    ]);
});

test("运行中只展示 running 与 error 状态的嵌套调用，隐藏已完成或取消噪音", () => {
    const lines = renderView(
        { code: "const r = await tools.read({ path: 'a.ts' });" },
        {
            content: [],
            details: {
                calls: [
                    { name: "find", status: "ok", durationMs: 40 },
                    { name: "read", args: '{"path":"a.ts"}', status: "running" },
                    { name: "grep", status: "cancelled" },
                ],
            },
        },
        { phase: "pending" },
    );

    assert.deepEqual(lines, [
        "⏺ **codemode**(find, read, grep)",
        "  ⎿  Running…",
        "     … read",
    ]);
});

test("失败脚本只暴露 Script error 详情并标记 Error", () => {
    const lines = renderView({ code: "await tools.nope({});" }, {
        content: [
            { type: "text", text: "Script failed\nWall time 0.4 seconds\nOutput:\n" },
            {
                type: "text",
                text: "Script error:\nTypeError: tools.nope is not a function\n\nTool calls made before the failure (they are not undone): find (ok)",
            },
        ],
        details: { calls: [{ name: "find", status: "ok" }] },
    }, { phase: "error" });

    assert.deepEqual(lines, [
        "⏺ **codemode**(find)",
        "  ⎿  Error: TypeError: tools.nope is not a function",
        "     ",
        "     Tool calls made before the failure (they are not undone): find (ok)",
    ]);
    for (const line of lines) {
        assert.equal(line.includes("\n"), false);
    }
});

test("终端不能内联展示图片时用文字占位代替 image() 输出", () => {
    const view = new ClaudeCodemodeView({ code: "image(block);" }, plainTheme as never);
    view.setShowImages(false);
    view.setResult(
        {
            content: [
                { type: "text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
                { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
            ],
            details: { calls: [] },
        },
        "success",
        false,
    );

    assert.equal(plain(view.render(100)).at(-1), "  ⎿  [Image: [image/png]]");
});

test("截断的脚本输出始终暴露完整输出路径", () => {
    const lines = renderView(
        { code: "text('x');" },
        successResult(
            Array.from({ length: 14 }, (_, index) => `output-${index + 1}`).join("\n"),
            { calls: [], fullOutputPath: "/tmp/pi-codemode/out.txt" },
        ),
    );

    assert.equal(lines.at(-1), "     Full output: /tmp/pi-codemode/out.txt");
});

test("超宽脚本与输出按宽度截断且不引入背景色", () => {
    const view = new ClaudeCodemodeView(
        { code: `const value = "${"x".repeat(200)}";` },
        plainTheme as never,
    );
    view.setResult(
        successResult("y".repeat(200), { calls: [] }),
        "success",
        false,
    );

    const lines = view.render(60);
    assert.equal(lines.length, 2);
    for (const line of lines) {
        assert.equal(line.includes("\n"), false);
        assert.equal(BACKGROUND_ANSI.test(line), false);
        assert.ok(visibleWidth(line) <= 60);
    }
    assert.ok(plain(lines)[0]?.endsWith("…"));
    assert.ok(plain(lines)[1]?.endsWith("…"));
});

test("非法 code 参数给出 [invalid arg] 而不是抛错", () => {
    const lines = renderView({ code: 42 }, undefined);
    assert.deepEqual(lines, ["⏺ **codemode**([invalid arg])", "  ⎿  Running…"]);
});

test("renderCall 与 renderResult 共享同一组件，结果槽位不重复输出", () => {
    const renderers = createClaudeCodemodeToolRenderer()("codemode", () => undefined);
    assert.ok(renderers?.renderCall && renderers.renderResult);

    const state: Record<string, unknown> = {};
    const args = { code: "text('hello');" };
    const callContext = createContext(args, state);
    const view = renderers.renderCall(args, plainTheme as never, callContext as never);
    const component = renderers.renderResult(
        successResult("hello", { calls: [] }) as never,
        { expanded: false, isPartial: false },
        plainTheme as never,
        createContext(args, state) as never,
    );

    assert.equal(
        stripTerminalSequences(view.render(80)[0] ?? ""),
        "⏺ **codemode**(text('hello');) · 1.2s",
    );
    assert.deepEqual(component.render(80), []);

    renderers.renderCall(args, plainTheme as never, {
        ...createContext(args, state),
        expanded: true,
    } as never);
    assert.equal(stripTerminalSequences(view.render(80)[0] ?? ""), "⏺ **codemode**(text('hello');)");
});

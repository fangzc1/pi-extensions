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

// Pi 的 highlightCode 读取模块级全局主题，未初始化会抛 "Theme not initialized"。
// 测试进程独立，这里初始化为内置主题即可，着色结果随后由 stripTerminalSequences 剥离。
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

test("折叠态用脚本首行摘要作为标题，结果按 ⎿ 展示摘要、嵌套调用与输出", () => {
    const args = {
        code: 'const files = await tools.find({ pattern: "**/*.ts" });\nconst count = files.length;\ntext(`count=${count}`);\n',
    };
    const lines = renderView(
        args,
        successResult("count=42", {
            calls: [
                { name: "find", args: '{"pattern":"**/*.ts"}', status: "ok", durationMs: 320 },
                { name: "read", args: '{"path":"src/a.ts"}', status: "error", durationMs: 1200 },
            ],
        }),
    );

    assert.deepEqual(lines, [
        '⏺ **codemode**(const files = await tools.find({ pattern: "**/*.ts" }); …)',
        "  ⎿  Ran **2** tool calls in 1.2s",
        "     ✓ find 320ms",
        "     ✗ read 1.2s",
        "     count=42",
    ]);
    for (const line of lines) {
        assert.equal(line.includes("\n"), false);
        assert.equal(BACKGROUND_ANSI.test(line), false);
    }
});

test("无嵌套调用、无输出时只保留摘要行", () => {
    const lines = renderView({ code: "store('answer', 42);" }, successResult("", { calls: [] }));

    assert.deepEqual(lines, ["⏺ **codemode**(store('answer', 42);)", "  ⎿  Ran script in 1.2s"]);
});

test("展开态展示完整脚本、嵌套调用参数与全部输出", () => {
    const code = 'const files = await tools.find({ pattern: "**/*.ts" });\nconst count = files.length;\ntext(`count=${count}`);\n';
    const output = ["line-01", "line-02"].join("\n");
    const collapsed = renderView(
        { code },
        successResult(output, { calls: [{ name: "find", args: '{"pattern":"**/*.ts"}', status: "ok" }] }),
    );
    const expanded = renderView(
        { code },
        successResult(output, {
            calls: [{ name: "find", args: '{"pattern":"**/*.ts"}', status: "ok", durationMs: 320 }],
        }),
        { expanded: true },
    );

    assert.equal(collapsed[2], "     ✓ find");
    assert.deepEqual(expanded.slice(0, 3), [
        "⏺ **codemode**(const files = await tools.find({ pattern: \"**/*.ts\" });",
        "     const count = files.length;",
        "     text(`count=${count}`);)",
    ]);
    assert.deepEqual(expanded.slice(-3), [
        '     ✓ find {"pattern":"**/*.ts"} 320ms',
        "     line-01",
        "     line-02",
    ]);
});

test("超过折叠预算的详情按行折叠并提示展开", () => {
    const output = Array.from({ length: 14 }, (_, index) => `output-${index + 1}`).join("\n");
    const collapsed = renderView(
        { code: "text('x');" },
        successResult(output, { calls: [{ name: "find", status: "ok" }] }),
    );
    const expanded = renderView(
        { code: "text('x');" },
        successResult(output, { calls: [{ name: "find", status: "ok" }] }),
        { expanded: true },
    );

    // 折叠预算是详情行 10 行：1 行嵌套调用 + 9 行输出 + 1 行提示。
    assert.equal(collapsed.length, 13);
    assert.match(collapsed.at(-1) ?? "", /^ {5}\.\.\. \(5 more lines, .+ to expand\)$/u);
    assert.equal(collapsed.some((line) => line.includes("output-14")), false);
    assert.equal(expanded.at(-1), "     output-14");
    assert.equal(expanded.some((line) => line.includes("more lines")), false);
});

test("多次模型调用合计成本，单次成本只在调用行内展示", () => {
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

    assert.deepEqual(single, [
        "⏺ **codemode**(text('x');)",
        "  ⎿  Ran **1** tool call in 1.2s",
        "     ✓ models.classify $0.0012",
    ]);
    assert.deepEqual(multiple.slice(-2), [
        "     ✓ models.generateImages $0.0018",
        "     Model calls: $0.0030",
    ]);
});

test("运行中展示嵌套调用实时状态而不是脚本输出", () => {
    const lines = renderView(
        { code: "const r = await tools.read({ path: 'a.ts' });" },
        {
            content: [],
            details: {
                calls: [
                    { name: "read", args: '{"path":"a.ts"}', status: "running" },
                    { name: "find", status: "cancelled" },
                ],
            },
        },
        { phase: "pending" },
    );

    assert.deepEqual(lines, [
        "⏺ **codemode**(const r = await tools.read({ path: 'a.ts' });)",
        "  ⎿  Running…",
        "     … read",
        "     ⊘ find",
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
        "⏺ **codemode**(await tools.nope({});)",
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

    assert.equal(plain(view.render(100)).at(-1), "     [Image: [image/png]]");
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
    assert.equal(lines.length, 3);
    for (const line of lines) {
        assert.equal(line.includes("\n"), false);
        assert.equal(BACKGROUND_ANSI.test(line), false);
        assert.ok(visibleWidth(line) <= 60);
    }
    assert.ok(plain(lines)[0]?.endsWith("…"));
    assert.ok(plain(lines)[2]?.endsWith("…"));
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
        "⏺ **codemode**(text('hello');)",
    );
    assert.deepEqual(component.render(80), []);

    // 展开状态由 context 传入，切到展开后同一组件立即给出完整脚本。
    renderers.renderCall(args, plainTheme as never, {
        ...createContext(args, state),
        expanded: true,
    } as never);
    assert.equal(stripTerminalSequences(view.render(80)[0] ?? ""), "⏺ **codemode**(text('hello');)");
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const BACKGROUND_ANSI = /\u001b\[(?:4[0-7]|10[0-7]|48(?:;[25];[^m]+)?)m/u;

const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => `**${text}**`,
};

function createContext(
    args: unknown,
    state: Record<string, unknown>,
    options: { isError?: boolean; expanded?: boolean; cwd?: string } = {},
) {
    return {
        args,
        state,
        expanded: options.expanded ?? false,
        lastComponent: undefined,
        isError: options.isError ?? false,
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        showImages: false,
        toolCallId: "call-1",
        cwd: options.cwd ?? process.cwd(),
        invalidate() {},
        keyText: () => "ctrl+o",
        keyHint: (_id: string, description: string) => `ctrl+o ${description}`,
    };
}

test("所有当前平台内置工具使用 Claude 自渲染外壳", async () => {
    const { createClaudeBuiltinToolDefinitions } = await import(
        "../.pi/extensions/claude-style/index.ts"
    );
    const tools = createClaudeBuiltinToolDefinitions(process.cwd(), "darwin");

    assert.deepEqual(
        tools.map((tool) => tool.name),
        ["read", "bash", "grep", "find", "ls"],
    );
    assert.ok(tools.every((tool) => tool.renderShell === "self"));
    assert.ok(tools.every((tool) => typeof tool.renderCall === "function"));
    assert.ok(tools.every((tool) => typeof tool.renderResult === "function"));

    const windowsTools = createClaudeBuiltinToolDefinitions(process.cwd(), "win32");
    assert.deepEqual(
        windowsTools.map((tool) => tool.name),
        ["read", "bash", "powershell", "grep", "find", "ls"],
    );
});

type ShutdownHandler = () => Promise<void> | void;

function createFakePi() {
    const registered: string[] = [];
    const rendererResolvers: Array<(toolName: string, next: () => unknown) => unknown> = [];
    const shutdownHandlers: ShutdownHandler[] = [];
    const api = {
        registerTool(tool: { name: string }) {
            registered.push(tool.name);
        },
        registerToolRenderer(resolver: (toolName: string, next: () => unknown) => unknown) {
            rendererResolvers.push(resolver);
        },
        on(event: string, handler: ShutdownHandler) {
            if (event === "session_shutdown") shutdownHandlers.push(handler);
        },
    };
    return {
        api,
        registered,
        rendererResolvers,
        async shutdown() {
            for (const handler of shutdownHandlers) await handler();
        },
    };
}

function expectedToolNames(): string[] {
    const platformTools =
        process.platform === "win32"
            ? ["read", "bash", "powershell", "grep", "find", "ls"]
            : ["read", "bash", "grep", "find", "ls"];
    return [...platformTools, "edit", "write"];
}

test("claude-style 单一入口注册全部平台工具、codemode 与外部工具渲染器", async () => {
    const { default: claudeStyle } = await import("../.pi/extensions/claude-style/index.ts");
    const pi = createFakePi();

    claudeStyle(pi.api as never);

    assert.deepEqual(pi.registered, expectedToolNames());
    assert.equal(pi.rendererResolvers.length, 2);
    assert.equal(pi.rendererResolvers[0]?.("codemode", () => undefined) != null, true);
    assert.equal(pi.rendererResolvers[1]?.("tool_search", () => undefined) != null, true);
    assert.equal(pi.rendererResolvers[1]?.("mcp__github__list_issues", () => undefined) != null, true);
    assert.equal(pi.rendererResolvers[1]?.("read_mcp_resource", () => undefined) != null, true);
    assert.equal(pi.rendererResolvers[1]?.("custom_tool", () => "passthrough"), "passthrough");
    await pi.shutdown();
});

test("全局版与项目版重复加载时只注册一次工具", async () => {
    const { default: claudeStyle } = await import("../.pi/extensions/claude-style/index.ts");
    const projectExtension = createFakePi();
    const globalExtension = createFakePi();

    claudeStyle(projectExtension.api as never);
    claudeStyle(globalExtension.api as never);

    assert.deepEqual(projectExtension.registered, expectedToolNames());
    assert.deepEqual(globalExtension.registered, []);
    assert.equal(globalExtension.rendererResolvers.length, 0);

    await projectExtension.shutdown();
    await globalExtension.shutdown();
});

test("会话关闭后重新加载仍能注册工具", async () => {
    const { default: claudeStyle } = await import("../.pi/extensions/claude-style/index.ts");
    const first = createFakePi();
    claudeStyle(first.api as never);
    await first.shutdown();

    const reloaded = createFakePi();
    claudeStyle(reloaded.api as never);

    assert.deepEqual(reloaded.registered, expectedToolNames());
    await reloaded.shutdown();
});

test("工具头严格使用 Claude pending、success、error 状态色且无外层背景", async () => {
    const { createClaudeBuiltinToolDefinitions } = await import(
        "../.pi/extensions/claude-style/index.ts"
    );
    const bash = createClaudeBuiltinToolDefinitions(process.cwd(), "darwin").find(
        (tool) => tool.name === "bash",
    );
    assert.ok(bash?.renderCall && bash.renderResult);

    const state: Record<string, unknown> = {};
    const args = { command: "printf hello" };
    const callContext = createContext(args, state);
    const view = bash.renderCall(args, plainTheme as never, callContext as never);
    const pending = view.render(80).join("\n");
    assert.match(pending, /^\u001b\[38;5;246m⏺\u001b\[39m \*\*bash\*\*\(printf hello\)/u);
    assert.match(stripTerminalSequences(pending), /\n  ⎿  Running…$/u);
    assert.equal(BACKGROUND_ANSI.test(pending), false);

    bash.renderResult(
        { content: [{ type: "text", text: "hello" }], details: undefined },
        { expanded: false, isPartial: false },
        plainTheme as never,
        createContext(args, state) as never,
    );
    const success = view.render(80).join("\n");
    assert.match(success, /^\u001b\[38;5;114m⏺\u001b\[39m/u);
    assert.match(stripTerminalSequences(success), /\n  ⎿  hello$/u);
    assert.equal(BACKGROUND_ANSI.test(success), false);

    bash.renderResult(
        { content: [{ type: "text", text: "Exit code 7" }], details: undefined },
        { expanded: false, isPartial: false },
        plainTheme as never,
        createContext(args, state, { isError: true }) as never,
    );
    const error = view.render(80).join("\n");
    assert.match(error, /^\u001b\[38;5;211m⏺\u001b\[39m/u);
    assert.match(stripTerminalSequences(error), /\n  ⎿  Error: Exit code 7$/u);
    assert.equal(BACKGROUND_ANSI.test(error), false);
});

test("bash 折叠态尾部优先展示最后 3 行，流式运行中仅展示最后 2 行", async () => {
    const { createClaudeBuiltinToolDefinitions } = await import(
        "../.pi/extensions/claude-style/index.ts"
    );
    const bash = createClaudeBuiltinToolDefinitions(process.cwd(), "darwin").find(
        (tool) => tool.name === "bash",
    );
    assert.ok(bash?.renderCall && bash.renderResult);

    const state: Record<string, unknown> = {};
    const args = { command: "npm test" };
    const view = bash.renderCall(args, plainTheme as never, createContext(args, state) as never);

    // pending 流式输出：仅保留尾部 2 行。
    bash.renderResult(
        { content: [{ type: "text", text: "step 1\nstep 2\nstep 3\nstep 4" }], details: undefined },
        { expanded: false, isPartial: true },
        plainTheme as never,
        createContext(args, state) as never,
    );
    assert.deepEqual(
        view.render(100).map((line) => stripTerminalSequences(line)),
        [
            "⏺ **bash**(npm test)",
            "  ⎿  … (2 earlier lines)",
            "     step 3",
            "     step 4",
        ],
    );

    // 完成态：保留尾部 3 行并附展开提示 + Full output。
    const finalOutput = ["boot", "compile", "run", "# tests 82", "# pass 82", "# fail 0"].join("\n");
    bash.renderResult(
        {
            content: [{ type: "text", text: finalOutput }],
            details: { fullOutputPath: "/tmp/pi-bash-out.log" } as never,
        },
        { expanded: false, isPartial: false },
        plainTheme as never,
        createContext(args, state) as never,
    );
    assert.deepEqual(
        view.render(100).map((line) => stripTerminalSequences(line)),
        [
            "⏺ **bash**(npm test)",
            "  ⎿  … (3 earlier lines, ctrl+o to expand)",
            "     # tests 82",
            "     # pass 82",
            "     # fail 0",
            "     Full output: /tmp/pi-bash-out.log",
        ],
    );

    // 展开态查看完整全部输出。
    bash.renderResult(
        {
            content: [{ type: "text", text: finalOutput }],
            details: { fullOutputPath: "/tmp/pi-bash-out.log" } as never,
        },
        { expanded: true, isPartial: false },
        plainTheme as never,
        createContext(args, state, { expanded: true }) as never,
    );
    const expanded = view.render(100).map((line) => stripTerminalSequences(line));
    assert.equal(expanded[1], "  ⎿  boot");
    assert.equal(expanded.at(-2), "     # fail 0");
    assert.equal(expanded.at(-1), "     Full output: /tmp/pi-bash-out.log");
});

test("流式增长的多行 Bash 参数保持单行标题高度", async () => {
    const { createClaudeBuiltinToolDefinitions } = await import(
        "../.pi/extensions/claude-style/index.ts"
    );
    const bash = createClaudeBuiltinToolDefinitions(process.cwd(), "darwin").find(
        (tool) => tool.name === "bash",
    );
    assert.ok(bash?.renderCall);

    const state: Record<string, unknown> = {};
    const initialArgs = { command: "set -euo pipefail" };
    const view = bash.renderCall(
        initialArgs,
        plainTheme as never,
        createContext(initialArgs, state) as never,
    );
    assert.equal(view.render(100).length, 2);

    const streamedArgs = {
        command: "set -euo pipefail\nE2E_DIR=$(mktemp -d /tmp/pi-e2e.XXXXXX)\nprintf '%s' \"$E2E_DIR\"",
    };
    const updatedView = bash.renderCall(
        streamedArgs,
        plainTheme as never,
        { ...createContext(streamedArgs, state), lastComponent: view } as never,
    );

    assert.equal(updatedView, view);
    assert.equal(updatedView.render(100).length, 2);
    assert.equal(
        stripTerminalSequences(updatedView.render(100)[0] ?? ""),
        "⏺ **bash**(set -euo pipefail …)",
    );
});

test("多行错误输出按行拆分、bash 失败超 12 行时保留尾部根因且不得内嵌换行符", async () => {
    const { createClaudeBuiltinToolDefinitions } = await import(
        "../.pi/extensions/claude-style/index.ts"
    );
    const bash = createClaudeBuiltinToolDefinitions(process.cwd(), "darwin").find(
        (tool) => tool.name === "bash",
    );
    assert.ok(bash?.renderCall && bash.renderResult);

    const state: Record<string, unknown> = {};
    const args = { command: "for v in 1 2; do echo === v$v ===; done" };
    const view = bash.renderCall(args, plainTheme as never, createContext(args, state) as never);

    bash.renderResult(
        { content: [{ type: "text", text: "=== v1 ===\n=== v2 ===\ngrep: no match" }], details: undefined },
        { expanded: false, isPartial: false },
        plainTheme as never,
        createContext(args, state, { isError: true }) as never,
    );
    const lines = view.render(80);
    for (const line of lines) {
        assert.equal(line.includes("\n"), false);
        assert.ok(visibleWidth(line) <= 80);
    }
    assert.equal(stripTerminalSequences(lines[1] ?? ""), "  ⎿  Error: === v1 ===");
    assert.equal(stripTerminalSequences(lines[2] ?? ""), "     === v2 ===");
    assert.equal(stripTerminalSequences(lines[3] ?? ""), "     grep: no match");

    // 超过 12 行错误日志时，bash 自动取尾部 12 行直达退出码。
    const longError = Array.from({ length: 16 }, (_, idx) => `err-line-${idx + 1}`).join("\n");
    bash.renderResult(
        { content: [{ type: "text", text: longError }], details: undefined },
        { expanded: false, isPartial: false },
        plainTheme as never,
        createContext(args, state, { isError: true }) as never,
    );
    const longLines = view.render(80).map((line) => stripTerminalSequences(line));
    assert.equal(longLines[1], "  ⎿  … (4 earlier lines, ctrl+o to expand)");
    assert.equal(longLines[2], "     err-line-5");
    assert.equal(longLines.at(-1), "     err-line-16");
});

test("只读探索类工具（read/grep/find/ls）在折叠态压缩为严格 1 行，展开态展示详情", async () => {
    const { createClaudeBuiltinToolDefinitions } = await import(
        "../.pi/extensions/claude-style/index.ts"
    );
    const cwd = "/Users/dev/project";
    const tools = createClaudeBuiltinToolDefinitions(cwd, "darwin");

    const cases = [
        {
            name: "read",
            args: { path: "/Users/dev/project/src/sample.txt", offset: 10, limit: 20 },
            result: "alpha\nbeta\n",
            pending: ["⏺ **read**(src/sample.txt:L10-29) · Reading…"],
            collapsed: ["⏺ **read**(src/sample.txt:L10-29) · 2 lines"],
            expanded: ["⏺ **read**(src/sample.txt:L10-29)", "  ⎿  Read **2** lines"],
        },
        {
            name: "find",
            args: { pattern: "**/*.txt", path: "/Users/dev/project/src" },
            result: "sample.txt\nnested/other.txt",
            pending: ['⏺ **find**("**/*.txt", src) · Searching…'],
            collapsed: ['⏺ **find**("**/*.txt", src) · 2 files'],
            expanded: [
                '⏺ **find**("**/*.txt", src)',
                "  ⎿  Found 2 files",
                "     sample.txt",
                "     nested/other.txt",
            ],
        },
        {
            name: "grep",
            args: { pattern: "NEEDLE", path: "/Users/dev/project/src" },
            result: "a.ts:2: NEEDLE beta\na.ts:9: NEEDLE gamma\nb.ts:1: NEEDLE alpha",
            pending: ['⏺ **grep**("NEEDLE", src) · Searching…'],
            collapsed: ['⏺ **grep**("NEEDLE", src) · 3 matches in 2 files'],
            expanded: [
                '⏺ **grep**("NEEDLE", src)',
                "  ⎿  Found 3 matches in 2 files",
                "     a.ts:2: NEEDLE beta",
                "     a.ts:9: NEEDLE gamma",
                "     b.ts:1: NEEDLE alpha",
            ],
        },
        {
            name: "ls",
            args: { path: "/Users/dev/project" },
            result: "README.md\nsrc/\npackage.json",
            pending: ["⏺ **ls**(.) · Listing…"],
            collapsed: ["⏺ **ls**(.) · 3 entries"],
            expanded: [
                "⏺ **ls**(.)",
                "  ⎿  Found 3 entries",
                "     README.md",
                "     src/",
                "     package.json",
            ],
        },
    ] as const;

    for (const fixture of cases) {
        const tool = tools.find((candidate) => candidate.name === fixture.name);
        assert.ok(tool?.renderCall && tool.renderResult);
        const state: Record<string, unknown> = {};
        const view = tool.renderCall(
            fixture.args as never,
            plainTheme as never,
            createContext(fixture.args, state, { cwd }) as never,
        );
        // pending 严格 1 行
        assert.deepEqual(
            view.render(120).map((line) => stripTerminalSequences(line)),
            fixture.pending,
        );

        // success 折叠态严格 1 行（高度不变）
        tool.renderResult(
            { content: [{ type: "text", text: fixture.result }], details: undefined },
            { expanded: false, isPartial: false },
            plainTheme as never,
            createContext(fixture.args, state, { cwd }) as never,
        );
        assert.deepEqual(
            view.render(120).map((line) => stripTerminalSequences(line)),
            fixture.collapsed,
        );

        // expanded 展开态展示明细（read 不展开源码）
        tool.renderResult(
            { content: [{ type: "text", text: fixture.result }], details: undefined },
            { expanded: true, isPartial: false },
            plainTheme as never,
            createContext(fixture.args, state, { cwd, expanded: true }) as never,
        );
        assert.deepEqual(
            view.render(120).map((line) => stripTerminalSequences(line)),
            fixture.expanded,
        );
    }
});

test("覆盖 renderer 后仍执行 Pi 原生 Read 与 Bash 语义", async () => {
    const { createClaudeBuiltinToolDefinitions } = await import(
        "../.pi/extensions/claude-style/index.ts"
    );
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-tools-"));
    try {
        await writeFile(join(directory, "sample.txt"), "hello\n", "utf8");
        const tools = createClaudeBuiltinToolDefinitions(directory, "darwin");
        const read = tools.find((tool) => tool.name === "read");
        const bash = tools.find((tool) => tool.name === "bash");
        assert.ok(read && bash);

        const readResult = await read.execute(
            "read-1",
            { path: "sample.txt" },
            undefined,
            undefined,
            undefined as never,
        );
        assert.equal(readResult.content[0]?.type, "text");
        assert.match(readResult.content[0]?.type === "text" ? readResult.content[0].text : "", /hello/u);

        const bashResult = await bash.execute(
            "bash-1",
            { command: "printf native-bash" },
            undefined,
            undefined,
            undefined as never,
        );
        assert.match(bashResult.content[0]?.type === "text" ? bashResult.content[0].text : "", /native-bash/u);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

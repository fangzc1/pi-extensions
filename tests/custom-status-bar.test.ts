import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";

import customStatusBar from "../.pi/extensions/custom-status-bar.ts";

function createFooter(options: {
    modelId?: string;
    provider?: string;
    contextWindow?: number;
    tokens?: number | null;
    sessionId?: string;
    extensionStatuses?: ReadonlyMap<string, string>;
} = {}) {
    const {
        modelId = "gpt-5.6-sol",
        provider = "openai-codex",
        contextWindow = 272_000,
        tokens = 357_004,
        sessionId = "019cf452-bac0-7f50-a438-f9781afc66b3",
        extensionStatuses = new Map(),
    } = options;
    const handlers = new Map<string, (...args: any[]) => unknown>();
    let footerFactory: ((...args: any[]) => any) | undefined;
    const pi = {
        on(name: string, handler: (...args: any[]) => unknown) {
            handlers.set(name, handler);
        },
    };
    customStatusBar(pi as never);

    const ctx = {
        cwd: "/Users/test/xclaw-new-api",
        model: {
            id: modelId,
            provider,
            contextWindow,
        },
        thinkingLevel: "medium",
        getContextUsage: () => ({
            tokens,
            contextWindow,
            percent: tokens === null ? null : (tokens / contextWindow) * 100,
        }),
        sessionManager: {
            getSessionId: () => sessionId,
        },
        ui: {
            setFooter(factory: (...args: any[]) => any) {
                footerFactory = factory;
            },
        },
    };

    handlers.get("session_start")?.({ type: "session_start" }, ctx);
    assert.ok(footerFactory);

    return footerFactory(
        { requestRender() {} },
        {
            fg: (color: string, text: string) => color === "dim"
                ? `\x1b[90m${text}\x1b[0m`
                : text,
        },
        {
            getGitBranch: () => "v1.0.0-rc.6-dev",
            getExtensionStatuses: () => extensionStatuses,
            onBranchChange: () => () => {},
        },
    );
}

test("会话信息固定从主状态信息的下一行开始", () => {
    const sessionId = "019cf452-bac0-7f50-a438-f9781afc66b3";
    const footer = createFooter({ sessionId });
    const renderedLines = footer.render(240);

    assert.equal(renderedLines.length, 2);
    const firstLine = stripVTControlCharacters(renderedLines[0]);
    const secondLine = stripVTControlCharacters(renderedLines[1]);
    assert.match(firstLine, /Context 34% used$/);
    assert.doesNotMatch(firstLine, /session:/);
    assert.match(secondLine, new RegExp(`\\(${sessionId}\\)$`));
    assert.doesNotMatch(secondLine, /session:/);
});

test("Pi home 目录和会话 ID 以紧凑格式展示为 dim 色", () => {
    const sessionId = "019cf452-bac0-7f50-a438-f9781afc66b3";
    const footer = createFooter({ sessionId });
    const renderedLines = footer.render(240);

    assert.equal(renderedLines.length, 2);
    const rawOutput = renderedLines[1];
    const output = stripVTControlCharacters(rawOutput);
    assert.equal(output, `pi-home:${getAgentDir()}(${sessionId})`);
    assert.match(rawOutput, /^\x1b\[90mpi-home:/);
});

test("Pi home 和会话 ID 超出宽度时自动换行且不省略", () => {
    const sessionId = "019cf452-bac0-7f50-a438-f9781afc66b3";
    const footer = createFooter({ sessionId });
    const renderedLines = footer.render(16).map(stripVTControlCharacters);
    const output = renderedLines.join("");

    assert.ok(output.includes(`pi-home:${getAgentDir()}`));
    assert.ok(output.includes(`(${sessionId})`));
    assert.ok(output.indexOf("pi-home:") < output.indexOf(`(${sessionId})`));
    assert.doesNotMatch(output, /session:/);
    assert.ok(renderedLines.length > 2);
    assert.ok(renderedLines.every((line: string) => visibleWidth(line) <= 16));
    assert.ok(renderedLines.every((line: string) => !line.includes("...")));
});

test("主状态行和扩展状态超出宽度时完整换行", () => {
    const extensionStatus = "LSP:typescript-language-server-ready";
    const footer = createFooter({
        extensionStatuses: new Map([["lsp", extensionStatus]]),
    });
    const lines = footer.render(16);
    const output = lines.map(stripVTControlCharacters).join("");

    assert.match(output, /gpt-5\.6-sol\[medium\] 1M/);
    assert.match(output, /xclaw-new-api/);
    assert.match(output, /v1\.0\.0-rc\.6-dev/);
    assert.match(output, /Context 34%/);
    assert.match(output, /used/);
    assert.match(output, new RegExp(extensionStatus));
    assert.ok(lines.every((line: string) => visibleWidth(line) <= 16));
    assert.doesNotMatch(output, /\.\.\./);
});

test("各 Provider 的 GPT-5.4 及以上模型统一使用 1M 最大上下文窗口", () => {
    for (const modelId of [
        "gpt-5.4",
        "gpt-5.5",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
    ]) {
        for (const provider of ["openai-codex", "openai"]) {
            const footer = createFooter({ modelId, provider });
            const output = stripVTControlCharacters(footer.render(240)[0]);

            assert.match(output, new RegExp(`${modelId.replaceAll(".", "\\.")}\\[medium\\] 1M`));
            assert.match(output, /Context 34% used/);
            assert.doesNotMatch(output, /Context 131% used/);
        }
    }
});

test("普通模型的窗口显示与占用率使用同一个配置值", () => {
    const footer = createFooter({
        modelId: "deepseek-v4-pro",
        provider: "deepseek",
        contextWindow: 1_000_000,
    });
    const output = stripVTControlCharacters(footer.render(240)[0]);

    assert.match(output, /deepseek-v4-pro\[medium\] 1M/);
    assert.match(output, /Context 36% used/);
});

test("压缩后 usage 未知时保留问号而不使用旧百分比", () => {
    const footer = createFooter({ tokens: null });
    const output = stripVTControlCharacters(footer.render(240)[0]);

    assert.match(output, /gpt-5\.6-sol\[medium\] 1M/);
    assert.match(output, /Context \? used/);
});

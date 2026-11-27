import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    buildModelEffortArgs,
    ConfigStore,
    DEFAULT_CONFIG,
    formatExtraArgs,
    groupModelCatalog,
    parseAgyModelsOutput,
    parseExtraArgs,
    probeCommand,
    validateCommand,
} from "../.pi/extensions/antigravity-cli/config.ts";
import { parseEnterArgs } from "../.pi/extensions/antigravity-cli/index.ts";
import { decorateTopBorderWithBadge } from "../.pi/extensions/antigravity-cli/renderer.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
    formatJsonRpcMessage,
    JsonRpcLineParser,
    parseElicitationRequest,
    parsePermissionRequest,
} from "../.pi/extensions/antigravity-cli/protocol.ts";

test("validateCommand 接受合法命令名与路径，拒绝空白与 shell 控制字符", () => {
    assert.deepEqual(validateCommand("agy"), { ok: true, value: "agy" });
    assert.deepEqual(validateCommand("  a-plain  "), { ok: true, value: "a-plain" });
    assert.deepEqual(validateCommand("/usr/local/bin/agy"), { ok: true, value: "/usr/local/bin/agy" });
    assert.deepEqual(validateCommand("~/bin/a"), { ok: true, value: "~/bin/a" });

    assert.equal(validateCommand("   ").ok, false);
    assert.equal(validateCommand("agy --model foo").ok, false);
    assert.equal(validateCommand("a;rm -rf /").ok, false);
    assert.equal(validateCommand("a|cat").ok, false);
    assert.equal(validateCommand("$(whoami)").ok, false);
});

test("parseExtraArgs 与 formatExtraArgs 支持引号参数并检测未闭合引号", () => {
    const parsed = parseExtraArgs('--model gemini-4-neon-high --agent "code reviewer" --add-dir \'/tmp/a b\'');
    assert.deepEqual(parsed, {
        ok: true,
        args: ["--model", "gemini-4-neon-high", "--agent", "code reviewer", "--add-dir", "/tmp/a b"],
    });

    assert.equal(parseExtraArgs('--model "unclosed').ok, false);
    assert.deepEqual(parseExtraArgs("   "), { ok: true, args: [] });
    assert.equal(
        formatExtraArgs(["--model", "gemini-4-neon-high", "--agent", "code reviewer"]),
        '--model gemini-4-neon-high --agent "code reviewer"',
    );
});

test("ConfigStore 支持默认值、原子读写以及损坏文件安全降级", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-config-test-"));
    const configPath = join(root, "antigravity-cli.json");
    const store = new ConfigStore(configPath);

    try {
        assert.deepEqual(store.read(), DEFAULT_CONFIG);

        const saved = store.write({
            command: "a",
            launchMode: "zsh-rc",
            model: "gemini-4-neon",
            effort: "xhigh",
            extraArgs: ["--sandbox"],
            syncSummaryToMainModel: false,
        });
        assert.deepEqual(saved, {
            command: "a",
            launchMode: "zsh-rc",
            model: "gemini-4-neon",
            effort: "xhigh",
            extraArgs: ["--sandbox"],
            syncSummaryToMainModel: false,
        });
        assert.deepEqual(store.read(), saved);

        await writeFile(configPath, "{broken-json", "utf8");
        const fallback = store.readSafe();
        assert.deepEqual(fallback.config, DEFAULT_CONFIG);
        assert.ok(fallback.warning?.includes("配置文件读取失败"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("probeCommand 在 auto 模式下优先直接执行 PATH 可执行文件，未命中时自动探测 zshrc 函数", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-probe-test-"));
    const binDir = join(root, "bin");
    const directScript = join(root, "fake-agy");
    const rcFile = join(root, ".zshrc");

    try {
        await writeFile(directScript, "#!/bin/sh\necho ok\n", "utf8");
        await chmod(directScript, 0o755);
        await writeFile(
            rcFile,
            `a() {\n  echo "proxy on"\n  "${directScript}" "$@"\n}\n`,
            "utf8",
        );

        const directProbe = await probeCommand(directScript, "auto", {
            env: { PATH: binDir, HOME: root },
            rcFile,
        });
        assert.equal(directProbe.ok, true);
        assert.equal(directProbe.resolvedMode, "direct");
        assert.equal(directProbe.resolvedPath, directScript);

        const zshProbe = await probeCommand("a", "auto", {
            env: { PATH: binDir, HOME: root },
            rcFile,
        });
        assert.equal(zshProbe.ok, true);
        assert.equal(zshProbe.resolvedMode, "zsh-rc");
        assert.equal(zshProbe.shellKind, "function");

        const missingDirect = await probeCommand("a", "direct", {
            env: { PATH: binDir, HOME: root },
            rcFile,
        });
        assert.equal(missingDirect.ok, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("JsonRpcLineParser 容错跳过 proxyctl 非 JSON 输出并正确解析请求、通知与响应", () => {
    assert.equal(
        formatJsonRpcMessage({ id: 1, method: "initialize", params: {} }),
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    );

    const parser = new JsonRpcLineParser();
    const combined = [
        "✅ 终端代理已开启，HTTP/HTTPS Proxy: http://127.0.0.1:7897",
        "✅ Git 代理未开启。如需开启，请使用 'proxyctl on --git'",
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }),
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } }),
        JSON.stringify({ jsonrpc: "2.0", id: "q-1", method: "elicitation/create", params: { requestedSchema: { type: "object", properties: {} } } }),
    ].join("\n");

    const frames = [
        ...parser.push(combined.slice(0, 42)),
        ...parser.push(combined.slice(42, 160)),
        ...parser.push(combined.slice(160)),
        ...parser.flush(),
    ];

    assert.equal(frames.length, 5);
    assert.equal(frames[0]?.kind, "noise");
    assert.equal(frames[1]?.kind, "noise");
    assert.equal(frames[2]?.kind, "response");
    assert.equal(frames[3]?.kind, "notification");
    assert.equal(frames[4]?.kind, "request");
});

test("parseElicitationRequest 与 parsePermissionRequest 正确解析单选、多选与权限审批 Schema", () => {
    const elicitation = parseElicitationRequest({
        sessionId: "s-1",
        toolCallId: "tc-1",
        message: "The agent has a question.",
        requestedSchema: {
            type: "object",
            properties: {
                q1: {
                    type: "string",
                    title: "3 和 4 的斜边？",
                    oneOf: [
                        { const: "1", title: "5" },
                        { const: "2", title: "6" },
                    ],
                },
                q1_other: { type: "string", title: "Other" },
                q2: {
                    type: "array",
                    title: "哪些是质数？",
                    items: {
                        anyOf: [
                            { const: "1", title: "2" },
                            { const: "2", title: "3" },
                            { const: "3", title: "4" },
                        ],
                    },
                },
                q2_other: { type: "string", title: "Other" },
            },
        },
    });

    assert.equal(elicitation.questions.length, 2);
    assert.equal(elicitation.questions[0]?.id, "q1");
    assert.equal(elicitation.questions[0]?.multiSelect, false);
    assert.equal(elicitation.questions[0]?.otherKey, "q1_other");
    assert.deepEqual(elicitation.questions[0]?.options, [
        { value: "1", label: "5" },
        { value: "2", label: "6" },
    ]);

    assert.equal(elicitation.questions[1]?.id, "q2");
    assert.equal(elicitation.questions[1]?.multiSelect, true);
    assert.equal(elicitation.questions[1]?.otherKey, "q2_other");
    assert.equal(elicitation.questions[1]?.options.length, 3);

    const perm = parsePermissionRequest({
        sessionId: "s-1",
        toolCall: { toolCallId: "tc-2", title: "Run npm test", rawInput: { CommandLine: "npm test" } },
        options: [
            { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
            { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
        ],
    });
    assert.equal(perm.title, "Run npm test");
    assert.equal(perm.options.length, 2);
});

test("buildModelEffortArgs、parseAgyModelsOutput、groupModelCatalog 与 parseEnterArgs 行为正确", () => {
    assert.deepEqual(buildModelEffortArgs("gemini-4-neon-high", undefined), ["--model", "gemini-4-neon-high"]);
    assert.deepEqual(buildModelEffortArgs(undefined, "high"), ["--effort", "high"]);
    assert.deepEqual(buildModelEffortArgs("gemini-4-neon-high", "low"), ["--model", "gemini-4-neon", "--effort", "low"]);

    const sampleStdout = [
        "✅ 终端代理已开启，HTTP/HTTPS Proxy: http://127.0.0.1:7897",
        "gemini-4-neon-high\tGemini 4 Neon (High)",
        "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
        "gemini-4-neon-low\tGemini 4 Neon (Low)",
        "gemini-pro-orchestrator-neon   Orchestrator (Neon)",
    ].join("\n");

    const families = groupModelCatalog(parseAgyModelsOutput(sampleStdout));
    assert.equal(families.length, 2);
    assert.deepEqual(families[0]?.efforts, ["low", "high", "xhigh"]);
    assert.deepEqual(families[1]?.efforts, []);

    assert.deepEqual(parseEnterArgs("--model gemini-4-neon --effort xhigh"), {
        ok: true,
        override: { model: "gemini-4-neon", effort: "xhigh" },
    });
    assert.deepEqual(parseEnterArgs("claude-opus-5-5 high"), {
        ok: true,
        override: { model: "claude-opus-5-5", effort: "high" },
    });
});

test("decorateTopBorderWithBadge 在输入框上边框左上角嵌入 AGY 标记，同时完整保留右侧会话名", () => {
    const width = 60;
    const rightLabel = " 笑话一则 ─";
    const rightWidth = visibleWidth(rightLabel);
    const borderWithRight = `${"─".repeat(width - rightWidth)}${rightLabel}`;
    const lines = [borderWithRight, "输入内容", "─".repeat(width)];

    const result = decorateTopBorderWithBadge(
        lines,
        width,
        "AGY(a · gemini-4-neon[high])",
        (t) => t,
        (t) => t,
    );

    assert.equal(visibleWidth(result[0]!), width);
    assert.ok(result[0]!.startsWith("─ AGY(a · gemini-4-neon[high]) ─"));
    assert.ok(result[0]!.endsWith(rightLabel), "右侧会话名必须完好保留");
    assert.equal(result[1], "输入内容");

    // 窄终端安全截断，不超出 width 且不覆盖右侧标题。
    const narrowWidth = 28;
    const narrowBorder = `${"─".repeat(narrowWidth - rightWidth)}${rightLabel}`;
    const narrowResult = decorateTopBorderWithBadge(
        [narrowBorder],
        narrowWidth,
        "AGY(a · gemini-4-neon[high])",
        (t) => t,
        (t) => t,
    );
    assert.equal(visibleWidth(narrowResult[0]!), narrowWidth);
    assert.ok(narrowResult[0]!.endsWith(rightLabel));
});


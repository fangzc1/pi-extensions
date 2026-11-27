import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    initTheme,
    ToolExecutionComponent,
    type ToolDefinition,
    type ToolRendererResolver,
    type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";

import claudeStyle from "../.pi/extensions/claude-style/index.ts";

const BACKGROUND_ANSI = /\u001b\[(?:4[0-7]|10[0-7]|48(?:;[25];[^m]+)?)m/u;

// 在独立进程中初始化 Pi 全局主题，确保 ToolExecutionComponent 与语法高亮使用真实主题实例。
initTheme();

function createMockTui(): TUI {
    return {
        requestRender() {},
    } as unknown as TUI;
}

function createPiHarness() {
    const tools = new Map<string, ToolDefinition<any, any, any>>();
    const resolvers: ToolRendererResolver[] = [];
    const shutdownHandlers: Array<() => Promise<void> | void> = [];

    const api = {
        registerTool(tool: ToolDefinition<any, any, any>) {
            tools.set(tool.name, tool);
        },
        registerToolRenderer(resolver: ToolRendererResolver) {
            resolvers.push(resolver);
        },
        on(event: string, handler: () => Promise<void> | void) {
            if (event === "session_shutdown") shutdownHandlers.push(handler);
        },
    };

    /** 按 Pi ExtensionRunner 相同链式顺序解析工具渲染定义。 */
    function resolveToolDefinition(
        toolName: string,
        fallback?: ToolRenderers,
    ): ToolDefinition<any, any, any> | ToolRenderers | undefined {
        const dispatch = (index: number): ToolRenderers | undefined => {
            const resolver = resolvers[index];
            if (!resolver) return tools.get(toolName) ?? fallback;
            return resolver(toolName, () => dispatch(index + 1));
        };
        return dispatch(0);
    }

    return {
        api,
        tools,
        resolvers,
        resolveToolDefinition,
        async shutdown() {
            for (const handler of shutdownHandlers) await handler();
        },
    };
}

function assertPhysicalLineContract(lines: readonly string[], width: number, allowBackground = false): void {
    for (const line of lines) {
        assert.equal(line.includes("\n"), false, `渲染行不得内嵌换行符: ${JSON.stringify(line)}`);
        assert.ok(
            visibleWidth(line) <= width,
            `渲染行超出终端宽度 ${width}: actual=${visibleWidth(line)} line=${stripTerminalSequences(line)}`,
        );
        if (!allowBackground) {
            assert.equal(
                BACKGROUND_ANSI.test(line),
                false,
                `非 edit diff 工具不得输出背景 ANSI: ${JSON.stringify(line)}`,
            );
        }
    }
}

/** 去掉 ToolExecutionComponent 在 self shell 下固定前置的 1 行空行。 */
function stripLeadingBlank(lines: readonly string[]): string[] {
    return lines[0] === "" ? lines.slice(1) : [...lines];
}

function plainBody(component: ToolExecutionComponent, width = 100): string[] {
    const raw = component.render(width);
    assertPhysicalLineContract(raw, width);
    return stripLeadingBlank(raw).map((line) => stripTerminalSequences(line));
}

test("端到端：通过 Pi ToolExecutionComponent 验证全链路真实执行、高信噪比折叠与点击展开", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-claude-style-e2e-"));
    const previousCwd = process.cwd();
    const harness = createPiHarness();

    try {
        process.chdir(workspace);
        await writeFile(
            join(workspace, "app.ts"),
            Array.from({ length: 24 }, (_, idx) => `export const item${idx + 1} = ${idx + 1};`).join("\n") + "\n",
            "utf8",
        );
        await writeFile(join(workspace, "notes.txt"), "needle one\nother line\nneedle two\n", "utf8");

        claudeStyle(harness.api as never);
        const ui = createMockTui();

        // 1. read：真实执行 + pending/success 严格 1 行（高度稳定），相对路径显示
        {
            const tool = harness.tools.get("read")!;
            const args = { path: join(workspace, "app.ts"), offset: 5, limit: 10 };
            const component = new ToolExecutionComponent("read", "e2e-read", args, { showImages: false }, tool, ui, workspace);
            const pending = plainBody(component);
            assert.deepEqual(pending, ["⏺ read(app.ts:L5-14) · Reading…"]);

            const result = await tool.execute("e2e-read", args, undefined, undefined, undefined as never);
            component.updateResult({ ...result, isError: false }, false);
            const collapsed = plainBody(component);
            assert.deepEqual(collapsed, ["⏺ read(app.ts:L5-14) · 10 lines"]);

            // 鼠标左键点击触发 Pi 原生展开，且 read 不向终端倾倒源码全文
            const handled = component.handleMouse({
                type: "click",
                button: "left",
                x: 2,
                y: 1,
                width: 100,
                height: 2,
            } as never);
            assert.equal(handled?.handled, true);
            const expanded = plainBody(component);
            assert.deepEqual(expanded, ["⏺ read(app.ts:L5-14)", "  ⎿  Read 10 lines"]);
        }

        // 2. grep / find / ls：真实执行 + 折叠态严格 1 行 + 展开态呈现完整明细
        {
            const grepTool = harness.tools.get("grep")!;
            const grepArgs = { pattern: "needle", path: workspace };
            const grepComp = new ToolExecutionComponent("grep", "e2e-grep", grepArgs, { showImages: false }, grepTool, ui, workspace);
            assert.deepEqual(plainBody(grepComp), ['⏺ grep("needle") · Searching…']);

            const grepRes = await grepTool.execute("e2e-grep", grepArgs, undefined, undefined, undefined as never);
            grepComp.updateResult({ ...grepRes, isError: false }, false);
            const grepCollapsed = plainBody(grepComp);
            assert.equal(grepCollapsed.length, 1);
            assert.match(grepCollapsed[0] ?? "", /^⏺ grep\("needle"\) · 2 matches in 1 file$/u);

            grepComp.setExpanded(true);
            const grepExpanded = plainBody(grepComp);
            assert.ok(grepExpanded.length >= 4);
            assert.ok(grepExpanded.some((line) => line.includes("needle one")));
            assert.ok(grepExpanded.some((line) => line.includes("needle two")));

            const findTool = harness.tools.get("find")!;
            const findArgs = { pattern: "*.txt", path: workspace };
            const findComp = new ToolExecutionComponent("find", "e2e-find", findArgs, { showImages: false }, findTool, ui, workspace);
            const findRes = await findTool.execute("e2e-find", findArgs, undefined, undefined, undefined as never);
            findComp.updateResult({ ...findRes, isError: false }, false);
            assert.deepEqual(plainBody(findComp), ['⏺ find("*.txt") · 1 file']);

            const lsTool = harness.tools.get("ls")!;
            const lsArgs = { path: workspace };
            const lsComp = new ToolExecutionComponent("ls", "e2e-ls", lsArgs, { showImages: false }, lsTool, ui, workspace);
            const lsRes = await lsTool.execute("e2e-ls", lsArgs, undefined, undefined, undefined as never);
            lsComp.updateResult({ ...lsRes, isError: false }, false);
            assert.deepEqual(plainBody(lsComp), ["⏺ ls(.) · 2 entries"]);
            // 窄终端（width=40）同样不得越宽或破坏单行契约
            assert.equal(plainBody(lsComp, 40).length, 1);
        }

        // 3. bash：真实运行多行输出脚本，折叠态仅展示尾部 3 行关键结果，展开看全量
        {
            const bashTool = harness.tools.get("bash")!;
            const bashArgs = {
                command: "printf 'boot\\nstep1\\nstep2\\n# tests 5\\n# pass 5\\n# fail 0\\n'",
            };
            const bashComp = new ToolExecutionComponent("bash", "e2e-bash", bashArgs, { showImages: false }, bashTool, ui, workspace);
            const bashRes = await bashTool.execute("e2e-bash", bashArgs, undefined, undefined, undefined as never);
            bashComp.updateResult({ ...bashRes, isError: false }, false);
            const collapsed = plainBody(bashComp);
            assert.equal(collapsed.length, 5);
            assert.match(collapsed[1] ?? "", /^  ⎿  … \(3 earlier lines, .+ to expand\)$/u);
            assert.equal(collapsed[2], "     # tests 5");
            assert.equal(collapsed[3], "     # pass 5");
            assert.equal(collapsed[4], "     # fail 0");

            bashComp.setExpanded(true);
            const expanded = plainBody(bashComp);
            assert.equal(expanded[1], "  ⎿  boot");
            assert.equal(expanded.at(-1), "     # fail 0");
        }

        // 4. write：真实写盘 + 折叠态仅统计行不铺代码正文 + 展开态完整高亮代码
        {
            const writeTool = harness.tools.get("write")!;
            const writePath = join(workspace, "created.ts");
            const writeArgs = {
                path: writePath,
                content: "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
            };
            const writeComp = new ToolExecutionComponent("write", "e2e-write", writeArgs, { showImages: false }, writeTool, ui, workspace);
            assert.deepEqual(plainBody(writeComp), [
                "⏺ write(created.ts)",
                "  ⎿  Writing 3 lines…",
            ]);

            const writeRes = await writeTool.execute("e2e-write", writeArgs, undefined, undefined, undefined as never);
            writeComp.updateResult({ ...writeRes, isError: false }, false);
            assert.equal(await readFile(writePath, "utf8"), writeArgs.content);

            const collapsed = plainBody(writeComp);
            assert.equal(collapsed.length, 2);
            assert.equal(collapsed[0], "⏺ write(created.ts)");
            assert.match(collapsed[1] ?? "", /^  ⎿  Wrote 3 lines \(.+ to expand\)$/u);

            writeComp.setExpanded(true);
            const expanded = plainBody(writeComp);
            assert.equal(expanded.length, 5);
            assert.ok(expanded.some((line) => line.includes("export const c = 3;")));
        }

        // 5. edit：真实修改大块代码 + 折叠态最多 12 行 diff + 展开态完整 diff
        {
            const editTool = harness.tools.get("edit")!;
            const oldBlock = Array.from({ length: 16 }, (_, idx) => `export const item${idx + 1} = ${idx + 1};`).join("\n");
            const newBlock = Array.from({ length: 16 }, (_, idx) => `export const item${idx + 1} = ${(idx + 1) * 10};`).join("\n");
            const editArgs = {
                path: join(workspace, "app.ts"),
                edits: [{ oldText: oldBlock, newText: newBlock }],
            };
            const editComp = new ToolExecutionComponent("edit", "e2e-edit", editArgs, { showImages: false }, editTool, ui, workspace);
            const editRes = await editTool.execute("e2e-edit", editArgs, undefined, undefined, undefined as never);
            editComp.updateResult({ ...editRes, isError: false }, false);

            const collapsedRaw = editComp.render(100);
            assertPhysicalLineContract(collapsedRaw, 100, true);
            const collapsed = stripLeadingBlank(collapsedRaw).map((line) => stripTerminalSequences(line));
            assert.equal(collapsed[0], "⏺ edit(app.ts)");
            assert.equal(collapsed[1], "  ⎿  Added 16 lines, removed 16 lines");
            // 标题 + 统计 + 12 行 diff + 1 行折叠提示 = 15 行
            assert.equal(collapsed.length, 15);
            assert.match(collapsed.at(-1) ?? "", /^     … \(\d+ more lines, .+ to expand\)$/u);

            editComp.setExpanded(true);
            const expandedRaw = editComp.render(100);
            assertPhysicalLineContract(expandedRaw, 100, true);
            const expanded = stripLeadingBlank(expandedRaw).map((line) => stripTerminalSequences(line));
            assert.ok(expanded.length > 30);
            assert.ok(expanded.some((line) => line.includes("item16 = 160;")));
        }

        // 6. codemode：经 resolver 解析为无边框高信噪比视图
        {
            const codemodeDef = harness.resolveToolDefinition("codemode");
            assert.ok(codemodeDef);
            const args = { code: "await tools.find({ pattern: '*.ts' });\ntext('ok');" };
            const comp = new ToolExecutionComponent("codemode", "e2e-cm", args, { showImages: false }, codemodeDef as never, ui, workspace);
            comp.updateResult(
                {
                    content: [
                        { type: "text", text: "Script completed\nWall time 0.8 seconds\nOutput:\n" },
                        { type: "text", text: "l1\nl2\nl3\nl4\nfinal-ok" },
                    ],
                    details: {
                        calls: [
                            { name: "find", status: "ok", durationMs: 20 },
                            { name: "read", status: "ok", durationMs: 12 },
                            { name: "read", status: "ok", durationMs: 15 },
                        ],
                    },
                    isError: false,
                },
                false,
            );
            const collapsed = plainBody(comp);
            assert.equal(collapsed[0], "⏺ codemode(find, read ×2) · 0.8s");
            assert.match(collapsed[1] ?? "", /^  ⎿  … \(2 earlier lines, .+ to expand\)$/u);
            assert.equal(collapsed[4], "     final-ok");

            comp.setExpanded(true);
            const expanded = plainBody(comp);
            assert.ok(expanded.some((line) => line.includes("Ran 3 tool calls in 0.8s")));
            assert.ok(expanded.some((line) => line.includes("✓ find 20ms")));
            assert.ok(expanded.some((line) => line.includes("l1")));
        }

        // 7. tool_search：经 resolver 收口为单行摘要，展开见完整列表
        {
            const searchDef = harness.resolveToolDefinition("tool_search");
            assert.ok(searchDef);
            const args = { query: "github issues" };
            const comp = new ToolExecutionComponent("tool_search", "e2e-ts", args, { showImages: false }, searchDef as never, ui, workspace);
            assert.deepEqual(plainBody(comp), ['⏺ tool_search("github issues") · Searching…']);

            comp.updateResult(
                {
                    content: [
                        {
                            type: "text",
                            text: "Loaded 2 tools. They are available from your next call:\n- mcp__github__list_issues: List issues\n- mcp__github__get_issue: Get issue",
                        },
                    ],
                    details: { loaded: ["mcp__github__list_issues", "mcp__github__get_issue"] },
                    isError: false,
                },
                false,
            );
            assert.deepEqual(plainBody(comp), ['⏺ tool_search("github issues") · loaded 2 tools']);

            comp.setExpanded(true);
            const expanded = plainBody(comp);
            assert.ok(expanded.some((line) => line.includes("mcp__github__list_issues")));
        }

        // 8. MCP 工具（含进度流、多行尾部截取、错误穿透与空返回单行化）与第三方工具透传
        {
            const mcpDef = harness.resolveToolDefinition("mcp__github__list_issues");
            assert.ok(mcpDef);
            const args = { repo: "pi-extensions", state: "open", per_page: 50, page: 1 };
            const comp = new ToolExecutionComponent("mcp__github__list_issues", "e2e-mcp", args, { showImages: false }, mcpDef as never, ui, workspace);
            assert.deepEqual(plainBody(comp), ['⏺ github/list_issues(repo: "pi-extensions", state: "open", +2) · Running…']);

            // onProgress 实时单行进度
            comp.updateResult(
                { content: [{ type: "text", text: "Fetching page 1/3" }], details: { server: "github", tool: "list_issues" }, isError: false },
                true,
            );
            assert.deepEqual(plainBody(comp), [
                '⏺ github/list_issues(repo: "pi-extensions", state: "open", +2) · Fetching page 1/3',
            ]);

            // 完成态多行输出：尾部 3 行 + 展开提示
            comp.updateResult(
                {
                    content: [{ type: "text", text: "row1\nrow2\nrow3\nrow4\nrow5" }],
                    details: { server: "github", tool: "list_issues", fullOutputPath: "/tmp/mcp-out.json" },
                    isError: false,
                },
                false,
            );
            const collapsed = plainBody(comp);
            assert.equal(collapsed[0], '⏺ github/list_issues(repo: "pi-extensions", state: "open", +2)');
            assert.match(collapsed[1] ?? "", /^  ⎿  … \(2 earlier lines, .+ to expand\)$/u);
            assert.equal(collapsed[2], "     row3");
            assert.equal(collapsed[4], "     row5");
            assert.equal(collapsed[5], "     Full output: /tmp/mcp-out.json");

            // 展开态显示完整 JSON 参数与全量返回
            comp.setExpanded(true);
            const expanded = plainBody(comp);
            assert.ok(expanded.some((line) => line.includes('"per_page": 50')));
            assert.ok(expanded.some((line) => line.includes("row1")));

            // MCP 资源工具无文本输出时折叠为严格 1 行 done
            const resDef = harness.resolveToolDefinition("read_mcp_resource");
            assert.ok(resDef);
            const resComp = new ToolExecutionComponent("read_mcp_resource", "e2e-mcp-res", { server: "docs", uri: "file:///a" }, { showImages: false }, resDef as never, ui, workspace);
            resComp.updateResult({ content: [], details: undefined, isError: false }, false);
            assert.deepEqual(plainBody(resComp), ['⏺ read_mcp_resource(uri: "file:///a", server: "docs") · done']);

            // MCP 错误态自动穿透
            resComp.updateResult(
                { content: [{ type: "text", text: "401 Unauthorized" }], details: undefined, isError: true },
                false,
            );
            assert.deepEqual(plainBody(resComp), [
                '⏺ read_mcp_resource(uri: "file:///a", server: "docs")',
                "  ⎿  Error: 401 Unauthorized",
            ]);

            // 非目标第三方工具严格透传
            const customFallback: ToolRenderers = { renderShell: "default" };
            assert.equal(harness.resolveToolDefinition("delegate_model", customFallback), customFallback);
        }
    } finally {
        process.chdir(previousCwd);
        await harness.shutdown();
        await rm(workspace, { recursive: true, force: true });
    }
});

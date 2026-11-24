import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ExecutionProgress } from "../.pi/extensions/model-delegation/progress.ts";

function send(progress: ExecutionProgress, event: unknown): void {
    progress.accept(event as AgentSessionEvent);
}

test("当前状态跟踪等待、思考、工具参数和文本输出，不泄露思考内容", () => {
    const progress = new ExecutionProgress();
    assert.match(progress.currentLines()[0], /等待模型响应/);
    send(progress, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } });
    assert.match(progress.currentLines()[0], /思考中/);
    assert.ok(!JSON.stringify(progress.snapshot()).includes("private reasoning"));
    send(progress, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } });
    assert.match(progress.currentLines()[0], /准备工具参数/);
    send(progress, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "正在核对投影" } });
    assert.match(progress.currentLines()[0], /输出中/);
    assert.ok(progress.currentLines().some((line) => line.includes("正在核对投影")));
});

test("当前工具不被历史淹没，并行完成后回到等待状态", () => {
    const progress = new ExecutionProgress();
    send(progress, { type: "tool_execution_start", toolCallId: "slow", toolName: "read", args: { path: "slow.ts" } });
    for (let index = 0; index < 10; index++) {
        send(progress, { type: "tool_execution_start", toolCallId: String(index), toolName: "read", args: { path: `${index}.ts` } });
        send(progress, { type: "tool_execution_end", toolCallId: String(index), isError: false });
    }
    assert.match(progress.currentLines()[0], /执行工具.*已完成 10/);
    assert.ok(progress.currentLines().some((line) => line.includes("slow.ts")));
    send(progress, { type: "tool_execution_end", toolCallId: "slow", isError: false });
    assert.match(progress.currentLines()[0], /等待模型响应.*已完成 11/);
    progress.finish();
    assert.match(progress.currentLines()[0], /已结束/);
});

test("模型文本增量合并、工具独立成行，并行工具按 ID 标记完成与失败", () => {
    const progress = new ExecutionProgress();
    for (const delta of ["先读取", "核心文件。"])
        send(progress, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
    send(progress, { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/one.ts" } });
    send(progress, { type: "tool_execution_start", toolCallId: "2", toolName: "ls", args: { path: "tests" } });
    send(progress, { type: "tool_execution_end", toolCallId: "2", isError: false });
    send(progress, { type: "tool_execution_end", toolCallId: "1", isError: true });
    assert.deepEqual(progress.lines(), ["  先读取核心文件。", "✗ 读取 src/one.ts · 失败", "✓ 查看目录 tests"]);
    assert.equal(progress.snapshot().finishedTools, 2);
});

test("最近过程优先显示，展开可查看已保留历史，超长任务有界", () => {
    const progress = new ExecutionProgress();
    for (let index = 0; index < 150; index++) {
        send(progress, { type: "tool_execution_start", toolCallId: String(index), toolName: "read", args: { path: `${index}.md` } });
        send(progress, { type: "tool_execution_end", toolCallId: String(index), isError: false });
    }
    assert.equal(progress.snapshot().items.length, 100);
    assert.equal(progress.snapshot().omitted, 50);
    assert.ok(progress.lines().at(-1)?.includes("149.md"));
    assert.ok(progress.lines(true).some((line) => line.includes("50.md")));
    assert.equal(progress.lines().length, 7);
});

test("终止时不留下虚假的运行状态，Shell 摘要不回显命令参数", () => {
    const progress = new ExecutionProgress();
    send(progress, { type: "tool_execution_start", toolCallId: "shell", toolName: "bash", args: { command: "SECRET=hidden do-something" } });
    progress.finish(true);
    assert.deepEqual(progress.lines(), ["− 执行命令 · 已取消"]);
    assert.ok(!JSON.stringify(progress.snapshot()).includes("SECRET"));
});

test("连续成功命令在默认视图合并，失败与运行状态不被合并", () => {
    const progress = new ExecutionProgress();
    for (let index = 0; index < 5; index++) {
        send(progress, { type: "tool_execution_start", toolCallId: String(index), toolName: "bash", args: { command: "private" } });
        if (index < 4) send(progress, { type: "tool_execution_end", toolCallId: String(index), isError: index === 3 });
    }
    assert.deepEqual(progress.lines(), ["✓ 执行命令 × 3", "✗ 执行命令 · 失败", "● 执行命令"]);
    assert.equal(progress.lines(true).length, 5);
    assert.equal(progress.snapshot().items.length, 5);
});

test("没有文本 delta 时仍保留完整消息，控制字符不破坏行布局", () => {
    const progress = new ExecutionProgress();
    send(progress, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第一步\n第二步" }] } });
    send(progress, { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "docs/\n设计.md" } });
    assert.deepEqual(progress.lines(), ["  第一步 第二步", "● 读取 docs/ 设计.md"]);
});

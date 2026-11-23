import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const hookConfigPath = new URL("../.codex/hooks.json", import.meta.url);
const loggerPath = new URL("../.codex/scripts/codex-conversation-logger.mjs", import.meta.url);

test("Codex Stop hook 配置和日志脚本存在", () => {
    assert.equal(existsSync(hookConfigPath), true);
    assert.equal(existsSync(loggerPath), true);
});

test("Codex Stop hook 调用对话日志脚本", async () => {
    const config = JSON.parse(await readFile(hookConfigPath, "utf8"));
    const commandHook = config.hooks?.Stop?.[0]?.hooks?.[0];

    assert.equal(commandHook?.type, "command");
    assert.equal(commandHook?.command, "node .codex/scripts/codex-conversation-logger.mjs");
});

function runLogger(payload: unknown): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(loggerPath)], { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
        child.stdin.end(JSON.stringify(payload));
    });
}

test("根据 Stop 载荷和 transcript 保存当前轮对话", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-conversation-logger-"));
    try {
        const transcriptPath = join(cwd, "transcript.jsonl");
        const transcript = [
            {
                timestamp: "2026-07-30T03:17:40.000Z",
                type: "response_item",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "旧问题" }],
                    internal_chat_message_metadata_passthrough: { turn_id: "old-turn" },
                },
            },
            {
                timestamp: "2026-07-30T03:17:41.000Z",
                type: "response_item",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "请总结项目" }],
                    internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
                },
            },
        ];
        await writeFile(transcriptPath, `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

        const result = await runLogger({
            session_id: "session-1",
            turn_id: "turn-1",
            transcript_path: transcriptPath,
            cwd,
            hook_event_name: "Stop",
            model: "gpt-5.6-sol",
            permission_mode: "default",
            stop_hook_active: false,
            last_assistant_message: "项目总结完成。",
        });

        assert.equal(result.code, 0, result.stderr);
        const logDir = join(cwd, ".codex", "logs");
        const files = existsSync(logDir) ? await readdir(logDir) : [];
        assert.equal(files.length, 1);
        const markdown = await readFile(join(logDir, files[0]), "utf8");
        assert.match(markdown, /# Codex 对话记录/);
        assert.match(markdown, /## 👤 用户\n\n请总结项目/);
        assert.match(markdown, /## 🤖 助手\n\n项目总结完成。/);
        assert.doesNotMatch(markdown, /旧问题/);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

/**
 * 对话日志扩展 - 将每轮完整的用户/助手文本保存为 Markdown。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ContentBlock {
    type?: string;
    text?: string;
}

interface MessageLike {
    role?: string;
    content?: unknown;
    timestamp?: number;
    stopReason?: string;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
}

interface EntryLike {
    type?: string;
    message?: MessageLike;
}

const runtimeState = globalThis as typeof globalThis & {
    __piTimerConversationLoggerOwner?: symbol;
};

function acquireRegistration(): (() => void) | undefined {
    if (runtimeState.__piTimerConversationLoggerOwner) return undefined;
    const owner = Symbol("pi-timer:conversation-logger");
    runtimeState.__piTimerConversationLoggerOwner = owner;
    return () => {
        if (runtimeState.__piTimerConversationLoggerOwner === owner) {
            runtimeState.__piTimerConversationLoggerOwner = undefined;
        }
    };
}

const FILTERED_MARKERS = [
    "<local-command-caveat>",
    "<command-name>",
    "<local-command-stdout>",
    "# Role:",
    "<system-reminder>",
];

/** 仅提取可展示的文本块，排除思考、工具调用和内部注入。 */
function extractText(content: unknown): string {
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";

    return content
        .flatMap((item): string[] => {
            if (typeof item === "string") return [item];
            if (!item || typeof item !== "object") return [];

            const block = item as ContentBlock;
            if (block.type !== "text" || typeof block.text !== "string") return [];
            if (FILTERED_MARKERS.some((marker) => block.text!.includes(marker))) return [];
            return [block.text];
        })
        .join("\n")
        .trim();
}

function findLatestUserMessage(entries: readonly EntryLike[]): MessageLike | undefined {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry?.type !== "message" || entry.message?.role !== "user") continue;

        const text = extractText(entry.message.content);
        if (text && !text.includes("[Request interrupted by user")) return entry.message;
    }
    return undefined;
}

function safeFilename(text: string): string {
    const prefix = text
        .replace(/[\n\r\t/:*?"<>|\\]/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 20);
    const hash = createHash("md5").update(text, "utf8").digest("hex").slice(0, 6);
    return `${prefix || "conversation"}_${hash}`;
}

function formatDate(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatDisplayTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatMarkdown(
    userText: string,
    assistantText: string,
    date: Date,
    sessionId: string,
    piHome: string,
    model: string,
    thinkingLevel: string,
): string {
    return `# Pi 对话记录

**时间**: ${formatDisplayTime(date)}

**Session ID**: ${sessionId}

**Pi Home 目录**: ${piHome}

**模型**: ${model}

**思考级别**: ${thinkingLevel}

---

## 👤 用户

${userText}

---

## 🤖 助手

${assistantText}

---

*本文件由 Pi Conversation Logger 扩展自动生成*
`;
}

async function writeUniqueLog(outputDir: string, basename: string, markdown: string): Promise<void> {
    for (let sequence = 1; ; sequence += 1) {
        const suffix = sequence === 1 ? "" : `_${sequence}`;
        const outputPath = join(outputDir, `${basename}${suffix}.md`);
        try {
            // wx 以原子方式避免并发会话或同秒同内容对话互相覆盖。
            await writeFile(outputPath, markdown, { encoding: "utf8", flag: "wx" });
            return;
        } catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        }
    }
}

export default function conversationLogger(pi: ExtensionAPI): void {
    const releaseRegistration = acquireRegistration();
    if (!releaseRegistration) return;

    const loggedUserTimestamps = new Set<number>();
    pi.on("session_shutdown", async () => releaseRegistration());

    pi.on("turn_end", async (event, ctx) => {
        const assistantMessage = event.message as MessageLike;

        // toolUse 表示本轮仍会继续调用模型，此时日志内容尚不完整。
        if (assistantMessage.role !== "assistant" || assistantMessage.stopReason === "toolUse") return;

        const assistantText = extractText(assistantMessage.content);
        const userMessage = findLatestUserMessage(ctx.sessionManager.getBranch() as EntryLike[]);
        const userText = userMessage ? extractText(userMessage.content) : "";
        if (!userMessage || !userText || !assistantText) return;

        const userTimestamp = userMessage.timestamp;
        if (typeof userTimestamp === "number" && loggedUserTimestamps.has(userTimestamp)) return;

        try {
            const date = new Date(assistantMessage.timestamp ?? Date.now());
            if (Number.isNaN(date.getTime())) throw new Error("消息时间戳无效");

            const outputDir = join(ctx.cwd, CONFIG_DIR_NAME, "logs");
            await mkdir(outputDir, { recursive: true });
            const basename = `${formatDate(date)}_${safeFilename(userText)}`;
            // 优先使用响应元数据，避免模型切换或虚拟模型路由后记录成当前选择。
            const provider = assistantMessage.provider ?? ctx.model?.provider;
            const model = assistantMessage.model ?? ctx.model?.id;
            const thinkingLevel = assistantMessage.thinkingLevel ?? ctx.thinkingLevel;
            const markdown = formatMarkdown(
                userText,
                assistantText,
                date,
                ctx.sessionManager.getSessionId(),
                getAgentDir(),
                model ? (provider ? `${provider}/${model}` : model) : "未知",
                thinkingLevel ?? "未知",
            );
            await writeUniqueLog(outputDir, basename, markdown);

            if (typeof userTimestamp === "number") loggedUserTimestamps.add(userTimestamp);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (ctx.hasUI) ctx.ui.notify(`保存对话日志失败：${message}`, "warning");
            else console.error(`[conversation-logger] 保存对话日志失败：${message}`);
        }
    });
}

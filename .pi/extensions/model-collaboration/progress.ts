import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface ProgressItem {
    kind: "text" | "tool";
    text: string;
    id?: string;
    state?: "running" | "done" | "error" | "cancelled";
}

const actions: Record<string, string> = {
    read: "读取", ls: "查看目录", grep: "搜索", find: "查找文件", edit: "修改", write: "写入", bash: "执行命令",
};

function clean(text: string): string {
    // 过程摘要不允许控制序列或多行参数破坏终端布局。
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

function toolLabel(name: string, input: unknown): string {
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const path = typeof args.path === "string" ? clean(args.path) : "";
    const pattern = typeof args.pattern === "string" ? clean(args.pattern).slice(0, 100) : "";
    // Shell 只显示动作，不回显可能包含凭据的完整命令。
    const target = name === "bash" ? "" : [path, pattern ? `「${pattern}」` : ""].filter(Boolean).join(" ");
    return `${actions[name] ?? clean(name)}${target ? ` ${target}` : ""}`;
}

/** 同一文本块合并增量，工具状态按调用 ID 更新，避免并行完成顺序串线。 */
export class ExecutionProgress {
    private items: ProgressItem[] = [];
    private textItem?: ProgressItem;
    private omitted = 0;
    private finishedTools = 0;

    accept(event: AgentSessionEvent): boolean {
        if (event.type === "auto_retry_start") {
            this.textItem = undefined;
            this.items.push({ kind: "text", text: `请求暂时失败，${Math.ceil(event.delayMs / 1000)} 秒后重试 ${event.attempt}/${event.maxAttempts}（Esc 可取消）` });
            this.trim();
            return true;
        }
        if (event.type === "auto_retry_end") {
            this.items.push({ kind: "text", text: event.success ? "重试成功，继续执行" : "重试已停止" });
            this.trim();
            return true;
        }
        if (event.type === "message_start") this.textItem = undefined;
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            if (!this.textItem) {
                this.textItem = { kind: "text", text: "" };
                this.items.push(this.textItem);
            }
            this.textItem.text = (this.textItem.text + event.assistantMessageEvent.delta).slice(-4000);
            this.trim();
            return true;
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
            const text = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
            if (text && !this.textItem) this.items.push({ kind: "text", text: text.slice(-4000) });
            this.textItem = undefined;
            this.trim();
            return true;
        }
        if (event.type === "tool_execution_start") {
            this.textItem = undefined;
            this.items.push({ kind: "tool", id: event.toolCallId, text: toolLabel(event.toolName, event.args), state: "running" });
            this.trim();
            return true;
        }
        if (event.type === "tool_execution_end") {
            const item = this.items.find((entry) => entry.id === event.toolCallId);
            if (item) item.state = event.isError ? "error" : "done";
            this.finishedTools++;
            return true;
        }
        return false;
    }

    finish(cancelled = false): void {
        for (const item of this.items) {
            if (item.state === "running") item.state = cancelled ? "cancelled" : "error";
        }
    }

    snapshot(): { items: ProgressItem[]; omitted: number; finishedTools: number } {
        return { items: this.items.map((item) => ({ ...item })), omitted: this.omitted, finishedTools: this.finishedTools };
    }

    lines(expanded = false): string[] {
        const entries = expanded ? this.items : this.items.slice(-6);
        const hidden = this.omitted + this.items.length - entries.length;
        const lines = hidden ? [`… 已收起 ${hidden} 条过程`] : [];
        for (const item of entries) {
            if (item.kind === "text") {
                const text = clean(item.text);
                lines.push(`  ${!expanded && text.length > 300 ? `…${text.slice(-300)}` : text}`);
            }
            else {
                const icon = { running: "●", done: "✓", error: "✗", cancelled: "−" }[item.state ?? "running"];
                const suffix = item.state === "error" ? " · 失败" : item.state === "cancelled" ? " · 已取消" : "";
                lines.push(`${icon} ${item.text}${suffix}`);
            }
        }
        return lines;
    }

    private trim(): void {
        // 保留有界过程，长任务不持续扩大工具结果和会话日志。
        while (this.items.length > 100) {
            const index = this.items.findIndex((item) => item.state !== "running");
            this.items.splice(index < 0 ? 0 : index, 1);
            this.omitted++;
        }
    }
}

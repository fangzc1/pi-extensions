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
    private phase = "等待模型响应";

    accept(event: AgentSessionEvent): boolean {
        if (event.type === "auto_retry_start") {
            this.phase = `等待重试 ${event.attempt}/${event.maxAttempts}`;
            this.textItem = undefined;
            this.items.push({ kind: "text", text: `请求暂时失败，${Math.ceil(event.delayMs / 1000)} 秒后重试 ${event.attempt}/${event.maxAttempts}（Esc 可取消）` });
            this.trim();
            return true;
        }
        if (event.type === "auto_retry_end") {
            this.phase = event.success ? "等待模型响应" : "重试已停止";
            this.items.push({ kind: "text", text: event.success ? "重试成功，继续执行" : "重试已停止" });
            this.trim();
            return true;
        }
        if (event.type === "message_start" && event.message.role === "assistant") {
            this.textItem = undefined;
            this.phase = "等待模型响应";
            return true;
        }
        if (event.type === "message_update") {
            const type = event.assistantMessageEvent.type;
            // 只呈现阶段，不保存或回显模型的内部思考。
            if (type.startsWith("thinking_")) {
                this.phase = "思考中";
                return true;
            }
            if (type.startsWith("toolcall_")) {
                this.phase = "准备工具参数";
                return true;
            }
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            this.phase = "输出中";
            if (!this.textItem) {
                this.textItem = { kind: "text", text: "" };
                this.items.push(this.textItem);
            }
            this.textItem.text = (this.textItem.text + event.assistantMessageEvent.delta).slice(-4000);
            this.trim();
            return true;
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
            this.phase = "处理模型响应";
            const text = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
            if (text && !this.textItem) this.items.push({ kind: "text", text: text.slice(-4000) });
            this.textItem = undefined;
            this.trim();
            return true;
        }
        if (event.type === "tool_execution_start") {
            this.phase = "执行工具";
            this.textItem = undefined;
            this.items.push({ kind: "tool", id: event.toolCallId, text: toolLabel(event.toolName, event.args), state: "running" });
            this.trim();
            return true;
        }
        if (event.type === "tool_execution_end") {
            const item = this.items.find((entry) => entry.id === event.toolCallId);
            if (item) item.state = event.isError ? "error" : "done";
            this.finishedTools++;
            this.phase = "等待模型响应";
            return true;
        }
        return false;
    }

    finish(cancelled = false): void {
        this.phase = cancelled ? "已取消" : "已结束";
        for (const item of this.items) {
            if (item.state === "running") item.state = cancelled ? "cancelled" : "error";
        }
    }

    snapshot(): { items: ProgressItem[]; omitted: number; finishedTools: number } {
        return { items: this.items.map((item) => ({ ...item })), omitted: this.omitted, finishedTools: this.finishedTools };
    }

    currentLines(): string[] {
        const running = this.items.filter((item) => item.state === "running");
        const lines = [`当前：${running.length ? `执行工具（${running.length} 项）` : this.phase} · 已完成 ${this.finishedTools} 次工具调用`];
        // 当前动作独立于历史窗口，慢工具不会被后来完成的工具挤掉。
        for (const item of running.slice(0, 3)) lines.push(`● ${item.text}`);
        if (running.length > 3) lines.push(`另有 ${running.length - 3} 项工具正在执行`);
        const latestTool = this.items.filter((item) => item.kind === "tool" && item.state !== "running").at(-1);
        if (latestTool) {
            const icon = latestTool.state === "done" ? "✓" : latestTool.state === "error" ? "✗" : "−";
            lines.push(`${icon} 最近工具：${latestTool.text}${latestTool.state === "error" ? " · 失败" : ""}`);
        }
        const latestText = this.items.filter((item) => item.kind === "text").at(-1);
        if (latestText) lines.push(`最近说明：${clean(latestText.text).slice(-300)}`);
        return lines;
    }

    lines(expanded = false): string[] {
        // 仅合并连续成功的同类操作，异常和正在运行的操作始终独立呈现。
        const groups: { item: ProgressItem; count: number }[] = [];
        for (const item of this.items) {
            const last = groups.at(-1);
            if (!expanded && item.kind === "tool" && item.state === "done"
                && last?.item.kind === "tool" && last.item.state === "done" && last.item.text === item.text) {
                last.count++;
            } else groups.push({ item, count: 1 });
        }
        const entries = expanded ? groups : groups.slice(-6);
        const hidden = this.omitted + groups.slice(0, groups.length - entries.length).reduce((sum, group) => sum + group.count, 0);
        const lines = hidden ? [`… 已收起 ${hidden} 条过程`] : [];
        for (const { item, count } of entries) {
            if (item.kind === "text") {
                const text = clean(item.text);
                lines.push(`  ${!expanded && text.length > 300 ? `…${text.slice(-300)}` : text}`);
            }
            else {
                const icon = { running: "●", done: "✓", error: "✗", cancelled: "−" }[item.state ?? "running"];
                const suffix = item.state === "error" ? " · 失败" : item.state === "cancelled" ? " · 已取消" : "";
                lines.push(`${icon} ${item.text}${count > 1 ? ` × ${count}` : ""}${suffix}`);
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

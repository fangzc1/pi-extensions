import { keyHint, keyText, type KeybindingHints, type Theme } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative } from "node:path";

export const DEFAULT_ERROR_COLLAPSED_LINES = 12;

export type ExpandHintSource = Pick<KeybindingHints, "keyText" | "keyHint">;
type FgTheme = Pick<Theme, "fg">;

const PRIORITY_ARG_KEYS = [
    "query",
    "path",
    "uri",
    "url",
    "server",
    "repo",
    "owner",
    "id",
    "name",
    "title",
    "command",
    "pattern",
] as const;

/** 将工作目录内的绝对路径转为相对路径；工作目录本身显示为 "."。 */
export function displayPath(path: string, cwd?: string): string {
    if (!cwd || !isAbsolute(path)) return path;
    const candidate = relative(cwd, path);
    if (candidate === "") return ".";
    return !candidate.startsWith("..") && !isAbsolute(candidate) ? candidate : path;
}

/** 统一换行为 LF，避免 CRLF 破坏 TUI 单行渲染契约。 */
export function normalizeNewlines(text: string): string {
    return text.replace(/\r\n?/gu, "\n");
}

/** 将输出拆分为去掉末尾空行的物理行数组；纯空白返回空数组。 */
export function splitOutputLines(output: string): string[] {
    return output.trim() ? normalizeNewlines(output).trimEnd().split("\n") : [];
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return count === 1 ? singular : pluralForm;
}

/**
 * 获取宿主配置的展开快捷键提示。
 * 优先使用 Pi 通过 ToolRenderContext 传入的绑定，缺失或未初始化时回退为默认提示。
 */
export function resolveExpandHint(hints?: ExpandHintSource): string {
    if (hints) {
        try {
            if (hints.keyText("app.tools.expand")) {
                return hints.keyHint("app.tools.expand", "to expand");
            }
        } catch {
            // 宿主未初始化快捷键或测试 mock 不完整时走回退分支。
        }
    }
    try {
        // 键位未注册时 keyText 返回空串，但 keyHint 仍会拼出前导空格的 " to expand"，
        // 因此先判空再生成提示语。
        if (!keyText("app.tools.expand")) {
            return "ctrl+o to expand";
        }
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "ctrl+o to expand";
    }
}

/** 拼接带折叠数量与展开快捷键的统一 muted 提示行。 */
export function formatFoldNotice(
    theme: FgTheme,
    label: string,
    expandHint?: string,
): string {
    if (!expandHint) {
        return theme.fg("muted", `… (${label})`);
    }
    return `${theme.fg("muted", `… (${label},`)} ${expandHint}${theme.fg("muted", ")")}`;
}

/** 头部优先折叠：保留前 limit 行，尾部附省略提示。 */
export function collapseHead(
    lines: readonly string[],
    limit: number,
    expanded: boolean,
    theme: FgTheme,
    expandHint?: string,
    noun = "line",
): string[] {
    if (expanded || lines.length <= limit) return [...lines];
    const hidden = lines.length - limit;
    return [
        ...lines.slice(0, limit),
        formatFoldNotice(theme, `${hidden} more ${plural(hidden, noun)}`, expandHint),
    ];
}

/** 尾部优先折叠：保留最后 limit 行，首部附前文省略提示。 */
export function collapseTail(
    lines: readonly string[],
    limit: number,
    expanded: boolean,
    theme: FgTheme,
    expandHint?: string,
    noun = "line",
): string[] {
    if (expanded || lines.length <= limit) return [...lines];
    const hidden = lines.length - limit;
    return [
        formatFoldNotice(theme, `${hidden} earlier ${plural(hidden, noun)}`, expandHint),
        ...lines.slice(-limit),
    ];
}

/**
 * 将错误信息严格按物理行拆分并着色，同时在折叠态应用合理上限避免超长堆栈刷屏。
 */
export function formatErrorLines(
    message: string,
    theme: FgTheme,
    options: {
        expanded: boolean;
        limit?: number;
        keep?: "head" | "tail";
        expandHint?: string;
        prefixErrorLabel?: boolean;
    },
): string[] {
    const limit = options.limit ?? DEFAULT_ERROR_COLLAPSED_LINES;
    const keep = options.keep ?? "head";
    const prefixErrorLabel = options.prefixErrorLabel ?? true;
    const rawLines = normalizeNewlines(message).split("\n");
    const colored = rawLines.map((line, index) => {
        const labeled =
            prefixErrorLabel && index === 0 && line.length > 0 && !line.startsWith("Error:")
                ? `Error: ${line}`
                : line;
        return labeled ? theme.fg("error", labeled) : labeled;
    });

    if (options.expanded || colored.length <= limit) return colored;
    return keep === "tail"
        ? collapseTail(colored, limit, false, theme, options.expandHint)
        : collapseHead(colored, limit, false, theme, options.expandHint);
}

function formatScalarArg(value: unknown, maxChars: number): string | undefined {
    if (typeof value === "string") {
        const flat = normalizeNewlines(value).replace(/\n/gu, " ").trim();
        const clipped = flat.length > maxChars ? `${flat.slice(0, Math.max(1, maxChars - 1))}…` : flat;
        return JSON.stringify(clipped);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return undefined;
}

/** 从工具对象参数中提取最多 maxKeys 个关键标量参数作为折叠态标题摘要。 */
export function summarizeObjectArgs(
    args: unknown,
    options: { maxKeys?: number; maxValueChars?: number } = {},
): string {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
    const record = args as Record<string, unknown>;
    const entries = Object.entries(record).filter(([, value]) => value !== undefined && value !== null);
    if (entries.length === 0) return "";

    const maxKeys = options.maxKeys ?? 2;
    const maxValueChars = options.maxValueChars ?? 40;

    const orderedKeys: string[] = [];
    for (const key of PRIORITY_ARG_KEYS) {
        if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined && record[key] !== null) {
            orderedKeys.push(key);
        }
    }
    for (const [key] of entries) {
        if (!orderedKeys.includes(key)) orderedKeys.push(key);
    }

    const parts: string[] = [];
    for (const key of orderedKeys) {
        if (parts.length >= maxKeys) break;
        const formatted = formatScalarArg(record[key], maxValueChars);
        if (formatted !== undefined) {
            parts.push(`${key}: ${formatted}`);
        }
    }

    // 全部为嵌套对象/数组时回退展示首键紧凑 JSON，避免标题完全丢失上下文。
    if (parts.length === 0) {
        const [firstKey, firstValue] = entries[0]!;
        let serialized = "";
        try {
            serialized = JSON.stringify(firstValue) ?? "";
        } catch {
            serialized = "[object]";
        }
        const clipped =
            serialized.length > maxValueChars
                ? `${serialized.slice(0, Math.max(1, maxValueChars - 1))}…`
                : serialized;
        parts.push(`${firstKey}: ${clipped}`);
    }

    const remaining = entries.length - parts.length;
    if (remaining > 0) parts.push(`+${remaining}`);
    return parts.join(", ");
}

/** 展开态下将参数压成紧凑单行（或按物理行拆分的 JSON）以便安全渲染。 */
export function formatExpandedArgs(args: unknown): string[] {
    if (args === undefined || args === null) return [];
    if (typeof args === "object" && !Array.isArray(args) && Object.keys(args as Record<string, unknown>).length === 0) {
        return [];
    }
    try {
        const text = JSON.stringify(args, null, 2);
        return text ? normalizeNewlines(text).split("\n") : [];
    } catch {
        return [String(args)];
    }
}

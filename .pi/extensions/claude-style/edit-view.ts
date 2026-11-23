import { generateDiffString, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { isAbsolute, relative } from "node:path";

const INDENT = "     ";
const CONTEXT_LINES = 3;

type Rgb = readonly [red: number, green: number, blue: number];

/** 从 Claude Code 截图逐像素采样得到的 Light Theme 色板。 */
const CLAUDE_COLORS = {
    title: [88, 110, 117],
    status: [45, 123, 57],
    text: [51, 51, 51],
    removedText: [208, 34, 46],
    addedText: [37, 138, 62],
    removedBg: [255, 220, 221],
    addedBg: [221, 255, 221],
    removedWordBg: [255, 199, 199],
    addedWordBg: [179, 255, 179],
} as const satisfies Record<string, Rgb>;

function foreground(color: Rgb, text: string): string {
    return `\u001b[38;2;${color.join(";")}m${text}\u001b[39m`;
}

function background(color: Rgb, text: string): string {
    return `\u001b[48;2;${color.join(";")}m${text}\u001b[49m`;
}

export interface ClaudeEditTheme {
    fg: Theme["fg"];
    bg: Theme["bg"];
    bold: Theme["bold"];
    inverse: Theme["inverse"];
}

export type CodeHighlighter = (code: string, language?: string) => string[];

type EditLineKind = "context" | "removed" | "added" | "separator";

interface EditLine {
    kind: EditLineKind;
    lineNumber?: number;
    content: string;
    pairedContent?: string;
}

export interface ClaudeEditModel {
    path: string;
    lines: EditLine[];
    additions: number;
    removals: number;
    phase: "preview" | "success" | "error";
    error?: string;
}

interface ParsedLine {
    prefix: " " | "+" | "-";
    lineNumber?: number;
    content: string;
    separator: boolean;
}

interface ChangeRange {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

function displayPath(path: string, cwd: string): string {
    if (!isAbsolute(path)) return path;
    const candidate = relative(cwd, path);
    return candidate && !candidate.startsWith("..") && !isAbsolute(candidate) ? candidate : path;
}

function parseLine(line: string): ParsedLine {
    if (line.trim() === "...") return { prefix: " ", content: "...", separator: true };
    const match = line.match(/^([ +\-])(\s*\d*)\s(.*)$/u);
    if (!match) return { prefix: " ", content: line, separator: false };
    const rawNumber = match[2]?.trim();
    return {
        prefix: match[1] as ParsedLine["prefix"],
        lineNumber: rawNumber ? Number(rawNumber) : undefined,
        content: match[3] ?? "",
        separator: false,
    };
}

/** 将连续 removed/added 组成 Claude Code 顺序，并保存词级配对信息。 */
function parseUnifiedLines(diff: string): { lines: EditLine[]; additions: number; removals: number } {
    const source = diff ? diff.split("\n").map(parseLine) : [];
    const lines: EditLine[] = [];
    let additions = 0;
    let removals = 0;
    let lineOffset = 0;
    let index = 0;

    while (index < source.length) {
        const current = source[index]!;
        if (current.separator) {
            lines.push({ kind: "separator", content: "..." });
            index++;
            continue;
        }
        if (current.prefix === " ") {
            lines.push({
                kind: "context",
                lineNumber:
                    current.lineNumber === undefined ? undefined : current.lineNumber + lineOffset,
                content: current.content,
            });
            index++;
            continue;
        }

        const removed: ParsedLine[] = [];
        while (index < source.length && source[index]?.prefix === "-") {
            removed.push(source[index]!);
            index++;
        }
        const added: ParsedLine[] = [];
        while (index < source.length && source[index]?.prefix === "+") {
            added.push(source[index]!);
            index++;
        }

        removed.forEach((line, pairIndex) => {
            lines.push({
                kind: "removed",
                lineNumber: line.lineNumber,
                content: line.content,
                pairedContent: added[pairIndex]?.content,
            });
        });
        added.forEach((line, pairIndex) => {
            lines.push({
                kind: "added",
                lineNumber: line.lineNumber,
                content: line.content,
                pairedContent: removed[pairIndex]?.content,
            });
        });
        removals += removed.length;
        additions += added.length;
        lineOffset += added.length - removed.length;
    }

    return { lines: trimContext(lines), additions, removals };
}

/** 每个变更块只保留前后各三行上下文，并去掉首尾无意义的省略号。 */
function trimContext(lines: EditLine[]): EditLine[] {
    const output: EditLine[] = [];
    const segments: EditLine[][] = [];
    let segment: EditLine[] = [];
    for (const line of lines) {
        if (line.kind === "separator") {
            if (segment.length > 0) segments.push(segment);
            segment = [];
        } else {
            segment.push(line);
        }
    }
    if (segment.length > 0) segments.push(segment);

    for (const currentSegment of segments) {
        const changes = currentSegment
            .map((line, index) => (line.kind === "context" ? -1 : index))
            .filter((index) => index >= 0);
        if (changes.length === 0) continue;
        const kept = currentSegment.filter((line, index) => {
            if (line.kind !== "context") return true;
            return changes.some((changeIndex) => Math.abs(changeIndex - index) <= CONTEXT_LINES);
        });
        if (kept.length === 0) continue;
        if (output.length > 0) output.push({ kind: "separator", content: "..." });
        output.push(...kept);
    }
    return output;
}

export function createClaudeEditModel(
    path: string,
    diff: string,
    cwd: string,
    phase: ClaudeEditModel["phase"],
    error?: string,
): ClaudeEditModel {
    const parsed = parseUnifiedLines(diff);
    return { path: displayPath(path, cwd), ...parsed, phase, error };
}

export function createClaudeEditPreview(
    path: string,
    edits: ReadonlyArray<{ oldText: string; newText: string }>,
    cwd: string,
): ClaudeEditModel {
    const blocks = edits.map((edit) => {
        const generated = generateDiffString(
            edit.oldText.replace(/\r\n?/gu, "\n"),
            edit.newText.replace(/\r\n?/gu, "\n"),
        );
        return generated.diff;
    });
    const model = createClaudeEditModel(path, blocks.join("\n     ...\n"), cwd, "preview");
    // replacement block 中的行号并不是文件行号，执行前保持为空。
    return { ...model, lines: model.lines.map((line) => ({ ...line, lineNumber: undefined })) };
}

interface TokenSpan {
    value: string;
    start: number;
    end: number;
}

function tokenize(text: string): TokenSpan[] {
    const tokens: TokenSpan[] = [];
    let offset = 0;
    for (const match of text.matchAll(/\s+|[\p{L}\p{N}_$]+|./gu)) {
        const value = match[0];
        const length = Array.from(value).length;
        tokens.push({ value, start: offset, end: offset + length });
        offset += length;
    }
    return tokens;
}

/** Claude 使用词级而非字符级变化背景，例如 Hello → Hello1 会高亮整个单词。 */
function findChangeRange(oldText: string, newText: string): ChangeRange {
    const oldTokens = tokenize(oldText);
    const newTokens = tokenize(newText);
    let prefix = 0;
    while (
        prefix < oldTokens.length &&
        prefix < newTokens.length &&
        oldTokens[prefix]?.value === newTokens[prefix]?.value
    ) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < oldTokens.length - prefix &&
        suffix < newTokens.length - prefix &&
        oldTokens[oldTokens.length - 1 - suffix]?.value ===
            newTokens[newTokens.length - 1 - suffix]?.value
    ) {
        suffix++;
    }
    return {
        oldStart: oldTokens[prefix]?.start ?? Array.from(oldText).length,
        oldEnd: oldTokens[oldTokens.length - 1 - suffix]?.end ?? Array.from(oldText).length,
        newStart: newTokens[prefix]?.start ?? Array.from(newText).length,
        newEnd: newTokens[newTokens.length - 1 - suffix]?.end ?? Array.from(newText).length,
    };
}

function emphasizeWord(
    raw: string,
    start: number,
    end: number,
    wordBackground: Rgb,
    lineBackground: Rgb,
): string {
    if (end <= start) return raw;
    const chars = Array.from(raw);
    const prefix = chars.slice(0, start).join("");
    const changed = chars.slice(start, end).join("");
    const suffix = chars.slice(end).join("");
    return (
        prefix +
        `\u001b[48;2;${wordBackground.join(";")}m${changed}` +
        `\u001b[48;2;${lineBackground.join(";")}m` +
        suffix
    );
}

function padToWidth(text: string, width: number): string {
    const truncated = truncateToWidth(text, Math.max(0, width), "…");
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Claude Code unified Edit renderer：相对路径、三行上下文、语法及词级高亮。 */
export class ClaudeEditView implements Component {
    private model: ClaudeEditModel;
    private theme: ClaudeEditTheme;

    constructor(
        model: ClaudeEditModel,
        theme: ClaudeEditTheme,
        _highlighter: CodeHighlighter = (code) => code.split("\n"),
    ) {
        this.model = model;
        this.theme = theme;
    }

    setModel(model: ClaudeEditModel): void {
        this.model = model;
    }

    setTheme(theme: ClaudeEditTheme): void {
        this.theme = theme;
    }

    invalidate(): void {
        // 不缓存 Theme ANSI，重绘时直接使用当前 Theme。
    }

    render(width: number): string[] {
        if (width <= 0) return [];
        const status =
            this.model.phase === "error"
                ? this.theme.fg("error", "⏺")
                : foreground(CLAUDE_COLORS.status, "⏺");
        const output = [
            truncateToWidth(
                `${status} ${this.theme.bold(foreground(CLAUDE_COLORS.title, "edit"))}(${foreground(
                    CLAUDE_COLORS.title,
                    this.model.path,
                )})`,
                width,
                "…",
            ),
        ];

        if (this.model.phase === "error") {
            // 错误信息按行拆分，避免单元素内嵌 \n 破坏差分渲染的行数假设。
            const message = this.model.error || "Edit failed";
            message.replace(/\r\n?/gu, "\n").split("\n").forEach((line, index) => {
                const prefix = index === 0 ? "  ⎿  " : INDENT;
                output.push(truncateToWidth(prefix + (line ? this.theme.fg("error", line) : line), width, "…"));
            });
            return output;
        }

        const stats =
            foreground(CLAUDE_COLORS.title, "  ⎿  Added ") +
            this.theme.bold(foreground(CLAUDE_COLORS.title, String(this.model.additions))) +
            foreground(
                CLAUDE_COLORS.title,
                this.model.additions === 1 ? " line, removed " : " lines, removed ",
            ) +
            this.theme.bold(foreground(CLAUDE_COLORS.title, String(this.model.removals))) +
            foreground(CLAUDE_COLORS.title, this.model.removals === 1 ? " line" : " lines");
        output.push(truncateToWidth(stats, width, "…"));

        const maxNumber = Math.max(0, ...this.model.lines.map((line) => line.lineNumber ?? 0));
        const numberWidth = Math.max(2, String(maxNumber).length);
        for (const line of this.model.lines) {
            output.push(this.renderLine(line, width, numberWidth));
        }
        return output;
    }

    private renderLine(line: EditLine, width: number, numberWidth: number): string {
        if (line.kind === "separator") {
            return truncateToWidth(`${INDENT}${this.theme.fg("dim", "...")}`, width, "…");
        }

        const raw = line.content.replace(/\t/gu, "    ");
        const number = line.lineNumber === undefined ? "" : String(line.lineNumber);
        if (line.kind === "context") {
            const context = `${number.padStart(numberWidth, " ")}  ${raw}`;
            return truncateToWidth(INDENT + foreground(CLAUDE_COLORS.text, context), width, "…");
        }

        const isRemoved = line.kind === "removed";
        const lineBackground = isRemoved ? CLAUDE_COLORS.removedBg : CLAUDE_COLORS.addedBg;
        const wordBackground = isRemoved
            ? CLAUDE_COLORS.removedWordBg
            : CLAUDE_COLORS.addedWordBg;
        let code = raw;
        if (line.pairedContent !== undefined) {
            const paired = line.pairedContent.replace(/\t/gu, "    ");
            const range = isRemoved ? findChangeRange(raw, paired) : findChangeRange(paired, raw);
            code = emphasizeWord(
                raw,
                isRemoved ? range.oldStart : range.newStart,
                isRemoved ? range.oldEnd : range.newEnd,
                wordBackground,
                lineBackground,
            );
        }

        const prefix = foreground(
            isRemoved ? CLAUDE_COLORS.removedText : CLAUDE_COLORS.addedText,
            `${number.padStart(numberWidth, " ")} ${isRemoved ? "-" : "+"}`,
        );
        const body = padToWidth(prefix + foreground(CLAUDE_COLORS.text, code), Math.max(0, width - visibleWidth(INDENT)));
        return INDENT + background(lineBackground, body);
    }
}

/**
 * 自动会话命名扩展
 *
 * - 首条用户消息提交后（before_agent_start），若会话尚未命名，后台生成名称，不等待助手回答。
 * - 用户已通过 /name 手动命名的会话不会被覆盖。
 * - 模型不可用或调用失败时，提示用户并暂用首条输入摘要作为名称。
 * - /auto-name：手动按当前对话重新生成名称（会覆盖已有名称）。
 * - /auto-name-settings：从已登录 provider 的全部模型中选择命名模型和思考级别，并全局保存。
 * - TUI 输入框上边框右侧展示最新会话名称，随自动命名和手动改名实时刷新。
 * - 默认仅在 tui / rpc 模式生效；设置 PI_AUTO_SESSION_NAME_ALL=1 可在 print / json 模式启用（便于调试）。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface NamingSettings {
	model: string;
	thinkingLevel: ModelThinkingLevel;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const settingsPath = () => join(getAgentDir(), "auto-session-name.json");

/** 每次重新读取全局设置，让其他 Pi 进程保存的选择也能生效。 */
function readSettings(): NamingSettings | undefined {
	let content: string;
	try {
		content = readFileSync(settingsPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value = JSON.parse(content);
	if (!value || typeof value.model !== "string" || !/^[^/]+\/.+/.test(value.model)
		|| !THINKING_LEVELS.includes(value.thinkingLevel)) {
		throw new Error("自动命名设置无效");
	}
	return { model: value.model, thinkingLevel: value.thinkingLevel };
}

/** 临时文件写完再替换，避免中断导致原有设置只写入一半。 */
function saveSettings(settings: NamingSettings): void {
	const path = settingsPath();
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, path);
	} finally {
		try { unlinkSync(temp); } catch { /* 写入前失败或已完成替换时，没有临时文件需要清理。 */ }
	}
}

/** 全量模型可能很多，使用带搜索框和有限可见行数的选择器。 */
async function selectNamingModel(ctx: ExtensionContext, current?: string): Promise<string | undefined> {
	// 仅按 provider 的登录凭证筛选，不使用会话的 scopedModels，保留未启用的模型。
	const models = ctx.modelRegistry.getAll().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
	const choices = models.map((model) => `${model.provider}/${model.id}`).sort();
	if (!choices.length) {
		ctx.ui.notify("没有已登录 provider 的模型，请先通过 /login 登录或配置 API key", "warning");
		return undefined;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const input = new Input();
		const createList = (filter = "") => new SelectList(
			choices
				.filter((value) => value.toLowerCase().includes(filter.toLowerCase()))
				.map((value) => ({ value, label: value })),
			10,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		let list = createList();
		if (current && choices.includes(current)) list.setSelectedIndex(choices.indexOf(current));
		input.onSubmit = () => {
			const selected = list.getSelectedItem();
			if (selected) done(selected.value);
		};
		input.onEscape = () => done(undefined);
		return {
			get focused() { return input.focused; },
			set focused(value: boolean) { input.focused = value; },
			render: (width: number) => [
				truncateToWidth(theme.fg("accent", "选择自动命名模型（输入搜索，↑↓ 选择，Enter 确认，Esc 取消）"), width),
				...input.render(width), ...list.render(width),
			].map((line) => truncateToWidth(line, width)),
			invalidate() { input.invalidate(); list.invalidate(); },
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
					list.handleInput(data);
				} else {
					const before = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== before) list = createList(input.getValue());
				}
				tui.requestRender();
			},
		};
	});
}

// 标题由模型主动概括；这里只限制异常长输出，不用短字符上限破坏完整语义。
const MAX_NAME_LENGTH = 200;
const FALLBACK_PREVIEW_LENGTH = 24;
const MAX_INPUT_CHARS = 2000;
const REQUEST_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `你是会话标题生成器。根据用户消息与已有的助手回复（可能尚无回复），生成一个简洁的中文会话名称。
要求：
- 生成简短、具体的主题名，例如“会话标题截断”“用户级 AGENTS 配置”“计费扣减异常”。
- 不复述用户请求，不写成“请帮我……”或“修复……问题”这样的指令句。
- 中文主题通常用 4~16 个汉字表达，语义完整优先，不为凑长度删减关键信息。
- 必要的专有名词、代码标识符保留英文原样，不截断单词。
- 只输出名称本身，不加引号、标点结尾、前缀或解释。`;

type TextBlock = { type: "text"; text: string };

/** 从消息 content 中提取纯文本，兼容字符串与内容块数组两种形态。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is TextBlock => typeof c === "object" && c !== null && (c as TextBlock).type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** 读取当前分支上的首条用户消息与首条助手文本回复。 */
function collectFirstExchange(ctx: ExtensionContext): { user: string; assistant: string } {
	let user = "";
	let assistant = "";
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: string; content?: unknown };
		if (!user && msg.role === "user") user = extractText(msg.content).trim();
		else if (user && !assistant && msg.role === "assistant") assistant = extractText(msg.content).trim();
		if (user && assistant) break;
	}
	return { user, assistant };
}

/** 清洗模型输出：取首行、去引号与结尾标点，仅对异常长标题应用安全上限。 */
function sanitizeName(raw: string): string {
	const firstLine = raw.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
	const cleaned = firstLine
		.replace(/^(会话名称|名称|标题)[:：]\s*/, "")
		.replace(/^["'“”‘’「」《》`]+|["'“”‘’「」《》`]+$/g, "")
		.replace(/[。．.！!？?，,；;：:]+$/, "")
		.trim();
	return [...cleaned].slice(0, MAX_NAME_LENGTH).join("");
}

/** 无模型可用时的兜底：截取首条用户消息。 */
function fallbackName(userText: string): string {
	const oneLine = userText.replace(/\s+/g, " ").trim();
	const chars = [...oneLine];
	return chars.length > FALLBACK_PREVIEW_LENGTH ? `${chars.slice(0, FALLBACK_PREVIEW_LENGTH).join("")}…` : oneLine;
}

/** 未设置时使用当前会话模型；显式设置后只调用指定模型，不意外使用其他付费模型。 */
function namingModel(ctx: ExtensionContext, settings?: NamingSettings) {
	if (!settings) return ctx.model;
	const idx = settings.model.indexOf("/");
	return ctx.modelRegistry.find(settings.model.slice(0, idx), settings.model.slice(idx + 1));
}

async function generateName(ctx: ExtensionContext, signal: AbortSignal, submittedPrompt?: string): Promise<string | undefined> {
	const exchange = collectFirstExchange(ctx);
	// before_agent_start 时本次用户消息尚未落盘，直接使用事件中的文本补足首条输入。
	const user = exchange.user || submittedPrompt?.trim() || "";
	const assistant = exchange.assistant;
	if (!user) return undefined;

	const prompt = `用户：${user.slice(0, MAX_INPUT_CHARS)}\n\n助手：${assistant.slice(0, MAX_INPUT_CHARS) || "（无文本回复）"}`;
	try {
		const settings = readSettings();
		const model = namingModel(ctx, settings);
		if (signal.aborted) return undefined;
		if (model) {
			const level = clampThinkingLevel(model, settings?.thinkingLevel ?? "off");
			// streamSimple 负责把统一思考级别转换为各 provider 的参数；complete 接收的是 provider 原生参数。
			const response = await ctx.modelRegistry.streamSimple(
				model,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				},
				{
					signal,
					reasoning: level === "off" ? undefined : level,
					// OpenCode Go 需要此标识；Pi 会将它转换为 x-opencode-session 路由头。
					sessionId: ctx.sessionManager.getSessionId(),
				},
			).result();
			if (response.stopReason !== "aborted" && response.stopReason !== "error") {
				const name = sanitizeName(extractText(response.content));
				if (name) return name;
			}
		}
	} catch {
		// 设置损坏、模型未登录或调用失败时，仍保留原有的首条消息兜底命名。
	}
	if (!signal.aborted && ctx.hasUI) {
		ctx.ui.notify("自动命名未成功，暂用输入摘要作为名称；请检查模型配置后用 /auto-name 重试。", "warning");
	}
	return signal.aborted ? undefined : fallbackName(user) || undefined;
}

export default function (pi: ExtensionAPI) {
	// 本运行时内是否已尝试过自动命名；会话替换后扩展运行时重建，状态自然重置
	let attempted = false;
	let disposed = false;
	let inflight: AbortController | undefined;
	let tuiRef: { requestRender(): void } | undefined;

	const enabledInMode = (ctx: ExtensionContext) =>
		ctx.mode === "tui" || ctx.mode === "rpc" || process.env.PI_AUTO_SESSION_NAME_ALL === "1";

	/** 生成并写入名称；写入前再次确认会话未被替换、未被用户手动命名（force 时忽略后者）。 */
	async function nameSession(ctx: ExtensionContext, force: boolean, submittedPrompt?: string): Promise<string | undefined> {
		inflight?.abort();
		const controller = new AbortController();
		inflight = controller;
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const sessionId = ctx.sessionManager.getSessionId();
		try {
			const name = await generateName(ctx, controller.signal, submittedPrompt);
			if (!name || disposed || controller.signal.aborted) return undefined;
			if (ctx.sessionManager.getSessionId() !== sessionId) return undefined;
			if (!force && pi.getSessionName()) return undefined;
			pi.setSessionName(name);
			return name;
		} finally {
			clearTimeout(timer);
			if (inflight === controller) inflight = undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		disposed = false;
		attempted = false;
		if (ctx.mode !== "tui") return;

		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			tuiRef = tui;
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const render = editor.render.bind(editor);
			// 只包装渲染并返回原对象，保留快捷键、IME 焦点及其他扩展的编辑器行为。
			editor.render = (width) => {
				const lines = render(width);
				const name = stripTerminalSequences(pi.getSessionName() ?? "").replace(/\s+/g, " ").trim();
				if (!name || !lines.length) return lines;

				// 只使用右侧连续边框的空间，不覆盖左侧工作状态或居中的滚动提示。
				const trailingWidth = stripTerminalSequences(lines[0]!).match(/─+$/)?.[0].length ?? 0;
				const available = Math.min(width, trailingWidth) - 4;
				if (available < 1) return lines;
				const label = ` ${truncateToWidth(name, available)} `;
				const color = editor.borderColor ?? theme.borderColor;
				// 不修改底层可能缓存的行数组；中文和 emoji 均按终端列宽截断。
				return [
					truncateToWidth(lines[0]!, width - visibleWidth(label) - 1, "") + color(`${label}─`),
					...lines.slice(1),
				];
			};
			return editor;
		});
	});

	pi.on("session_info_changed", () => {
		tuiRef?.requestRender();
	});

	pi.on("session_shutdown", async () => {
		tuiRef = undefined;
		disposed = true;
		inflight?.abort();
		inflight = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (attempted || disposed || !enabledInMode(ctx) || event.messageType !== "user" || !event.prompt.trim()) return;
		if (pi.getSessionName()) {
			attempted = true;
			return;
		}
		attempted = true;
		// 不返回命名 Promise，主模型无需等待标题生成即可开始回答。
		void nameSession(ctx, false, event.prompt).catch(() => undefined);
	});

	pi.registerCommand("auto-name-settings", {
		description: "选择自动命名模型（已登录 provider 的全部模型）和思考级别，全局保存",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("请在 TUI 模式中使用 /auto-name-settings", "warning");
				return;
			}
			try {
				const settings = readSettings();
				const ref = await selectNamingModel(ctx, settings?.model);
				if (!ref || disposed) return;
				const model = namingModel(ctx, { model: ref, thinkingLevel: "off" });
				if (!model) throw new Error("所选模型已不可用，请重新选择");
				const levels = getSupportedThinkingLevels(model);
				const current = clampThinkingLevel(model, settings?.thinkingLevel ?? "off");
				const level = await ctx.ui.select(`命名思考级别（当前：${current}）`, levels);
				if (!level || disposed) return;
				if (!levels.includes(level as ModelThinkingLevel)) throw new Error("思考级别无效");
				saveSettings({ model: ref, thinkingLevel: level as ModelThinkingLevel });
				// 取消使用旧设置的后台请求，避免保存后又写入旧模型生成的标题。
				inflight?.abort();
				ctx.ui.notify(`自动命名设置已保存：${ref} · ${level}`, "info");
			} catch (error) {
				ctx.ui.notify(`自动命名设置失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("auto-name", {
		description: "根据当前对话自动生成会话名称（覆盖已有名称）",
		handler: async (_args, ctx) => {
			const name = await nameSession(ctx, true).catch(() => undefined);
			if (ctx.hasUI) {
				ctx.ui.notify(name ? `会话已命名：${name}` : "未能生成会话名称（无用户消息或已取消）", name ? "info" : "warning");
			}
		},
	});
}

import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentDir: string;
let previousAgentDir: string | undefined;
beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(join(tmpdir(), "auto-name-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});
import { getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import autoSessionName from "../.pi/extensions/auto-session-name.ts";
import { DoubleEscapeEditor } from "../.pi/extensions/rewind-claude/double-escape-editor.ts";

// 仅替换扩展宿主边界；通过真实注册的事件和编辑器工厂验证显示行为。
function createHarness(mode = "tui", initialName: string | undefined = "已有会话") {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	let name: string | undefined = initialName;
	let factory: any;
	let renders = 0;
	const base = {
		actionHandlers: new Map(),
		text: "草稿",
		render(width: number) { return ["─".repeat(width), this.text, "─".repeat(width)]; },
		handleInput() {},
	};
	const previous = () => base;
	factory = previous;
	const ctx: any = {
		mode,
		hasUI: mode === "tui",
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (value: any) => { factory = value; },
			notify() {},
		},
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [{ type: "message", message: { role: "user", content: "修复标题展示" } }],
		},
		modelRegistry: { find: () => undefined, getAll: () => [] },
	};
	const pi: any = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand: (command: string, options: any) => commands.set(command, options),
		getSessionName: () => name,
		setSessionName: (value: string | undefined) => {
			name = value;
			void handlers.get("session_info_changed")?.({ name }, ctx);
		},
	};
	autoSessionName(pi);
	return {
		base, previous, ctx, pi, commands,
		get factory() { return factory; },
		get renders() { return renders; },
		emit: async (event: string, payload = {}) => handlers.get(event)?.(payload, ctx),
		createEditor: () => factory({ requestRender: () => { renders++; } }, { borderColor: (value: string) => `\x1b[31m${value}\x1b[39m` }, {}),
	};
}

const hiddenModel = { provider: "test", id: "hidden-model", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };

function mockModelSelection(h: ReturnType<typeof createHarness>, level = "high") {
	const requests: any[] = [];
	h.ctx.modelRegistry = {
		getAll: () => [hiddenModel],
		hasConfiguredAuth: (model: any) => model.provider === "test",
		getAvailable: () => { throw new Error("不应读取已启用模型"); },
		find: (provider: string, id: string) => provider === hiddenModel.provider && id === hiddenModel.id ? hiddenModel : undefined,
		streamSimple: (model: any, context: any, options: any) => {
			requests.push({ model, context, options });
			return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "测试模型命名" }] }) };
		},
	};
	h.ctx.ui.custom = async (factory: any) => {
		let result: any;
		const component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, getKeybindings(), (value: any) => { result = value; });
		component.handleInput("hidden-model");
		assert.match(component.render(80).join("\n"), /test\/hidden-model/);
		component.handleInput("\r");
		return result;
	};
	h.ctx.ui.select = async (_title: string, options: string[]) => {
		assert.ok(options.includes(level));
		return level;
	};
	return requests;
}

test("仅显示已登录 provider 的全部模型，排除未登录 provider", async () => {
	const h = createHarness();
	mockModelSelection(h);
	h.ctx.modelRegistry.getAll = () => [
		hiddenModel,
		{ ...hiddenModel, id: "not-enabled" },
		{ ...hiddenModel, provider: "not-logged-in", id: "private-model" },
	];
	h.ctx.ui.notify = (message: string, type: string) => { if (type === "error") assert.fail(message); };
	h.ctx.ui.custom = async (factory: any) => {
		let result: any;
		const component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, getKeybindings(), (value: any) => { result = value; });
		const text = component.render(100).join("\n");
		assert.match(text, /test\/hidden-model/);
		assert.match(text, /test\/not-enabled/);
		assert.doesNotMatch(text, /not-logged-in|private-model/);
		component.handleInput("\x1b");
		return result;
	};
	await h.commands.get("auto-name-settings").handler("", h.ctx);
});

test("没有已登录 provider 时提示用户，不打开模型选择器", async () => {
	const h = createHarness();
	mockModelSelection(h);
	h.ctx.modelRegistry.hasConfiguredAuth = () => false;
	const notices: string[] = [];
	h.ctx.ui.notify = (message: string, type: string) => {
		if (type === "error") assert.fail(message);
		notices.push(message);
	};
	h.ctx.ui.custom = () => assert.fail("没有已登录 provider 时不应打开选择器");
	await h.commands.get("auto-name-settings").handler("", h.ctx);
	assert.match(notices.join("\n"), /登录|凭证/);
});

test("设置命令从已登录 provider 的全部模型选择并全局保存思考级别，重新加载后仍用于命名", async () => {
	const h = createHarness();
	mockModelSelection(h);
	assert.ok(h.commands.has("auto-name-settings"), "应注册设置命令");
	await h.commands.get("auto-name-settings").handler("", h.ctx);
	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "auto-session-name.json"), "utf8")), {
		model: "test/hidden-model", thinkingLevel: "high",
	});
	const restored = createHarness();
	const requests = mockModelSelection(restored);
	await restored.commands.get("auto-name").handler("", restored.ctx);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].model, hiddenModel);
	assert.equal(requests[0].options.reasoning, "high");
	assert.equal(restored.pi.getSessionName(), "测试模型命名");
});

test("取消模型或思考级别选择不覆盖已有全局设置", async () => {
	const path = join(agentDir, "auto-session-name.json");
	const original = JSON.stringify({ model: "test/hidden-model", thinkingLevel: "low" });
	writeFileSync(path, original);
	for (const stage of ["model", "thinking"]) {
		const h = createHarness();
		mockModelSelection(h);
		assert.ok(h.commands.has("auto-name-settings"));
		if (stage === "model") h.ctx.ui.custom = async () => undefined;
		else h.ctx.ui.select = async () => undefined;
		await h.commands.get("auto-name-settings").handler("", h.ctx);
		assert.equal(readFileSync(path, "utf8"), original);
	}
});

test("非思考模型仅提供 off，已保存的设置在自动命名中生效", async () => {
	const h = createHarness("tui", "");
	const requests = mockModelSelection(h, "off");
	const model = { ...hiddenModel, reasoning: false };
	h.ctx.modelRegistry.getAll = () => [model];
	h.ctx.modelRegistry.find = () => model;
	h.ctx.ui.select = async (_: string, options: string[]) => {
		assert.deepEqual(options, ["off"]);
		return "off";
	};
	assert.ok(h.commands.has("auto-name-settings"));
	await h.commands.get("auto-name-settings").handler("", h.ctx);
	await h.emit("before_agent_start", { messageType: "user", prompt: "修复标题展示" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests[0].options.reasoning, undefined);
	assert.equal(h.pi.getSessionName(), "测试模型命名");
});

test("配置损坏和保存失败会通知用户，不错误报告保存成功", async () => {
	const h = createHarness();
	mockModelSelection(h);
	const notices: string[] = [];
	h.ctx.ui.notify = (message: string) => notices.push(message);
	assert.ok(h.commands.has("auto-name-settings"));
	const path = join(agentDir, "auto-session-name.json");
	writeFileSync(path, "{broken");
	await h.commands.get("auto-name-settings").handler("", h.ctx);
	assert.match(notices.join("\n"), /失败|错误|无效/);
	assert.equal(readFileSync(path, "utf8"), "{broken");
	rmSync(path);
	mkdirSync(path);
	notices.length = 0;
	await h.commands.get("auto-name-settings").handler("", h.ctx);
	assert.match(notices.join("\n"), /失败|错误/);
	assert.doesNotMatch(notices.join("\n"), /已保存/);
});

test("支持 max 的模型完整传递级别，模型能力变化时自动调整", async () => {
	const h = createHarness();
	const requests = mockModelSelection(h, "max");
	await h.commands.get("auto-name-settings").handler("", h.ctx);
	await h.commands.get("auto-name").handler("", h.ctx);
	assert.equal(requests[0].options.reasoning, "max");
	h.ctx.modelRegistry.find = () => ({ ...hiddenModel, thinkingLevelMap: {} });
	await h.commands.get("auto-name").handler("", h.ctx);
	assert.equal(requests[1].options.reasoning, "high");
});

test("命名请求携带当前会话标识，避免 OpenCode 拒绝请求后直接照搬输入", async () => {
	const h = createHarness("tui", "");
	mockModelSelection(h);
	h.ctx.model = hiddenModel;
	const stream = h.ctx.modelRegistry.streamSimple;
	h.ctx.modelRegistry.streamSimple = (model: any, context: any, options: any) => {
		if (options.sessionId !== "session-1") {
			return { result: async () => ({ stopReason: "error", errorMessage: "400 MissingSessionID", content: [] }) };
		}
		return stream(model, context, options);
	};
	await h.emit("before_agent_start", { messageType: "user", prompt: "修复标题展示" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.pi.getSessionName(), "测试模型命名");
	await h.commands.get("auto-name").handler("", h.ctx);
	assert.equal(h.pi.getSessionName(), "测试模型命名");
});

test("指定模型消失或请求失败时明确提示兜底，不调用主会话模型", async () => {
	for (const failure of ["missing", "throw", "error", "empty"]) {
		const h = createHarness();
		mockModelSelection(h);
		await h.commands.get("auto-name-settings").handler("", h.ctx);
		const notices: { message: string; type: string }[] = [];
		h.ctx.ui.notify = (message: string, type: string) => notices.push({ message, type });
		h.ctx.model = { provider: "expensive", id: "main" };
		if (failure === "missing") h.ctx.modelRegistry.find = () => undefined;
		h.ctx.modelRegistry.streamSimple = (model: any) => {
			assert.equal(model, hiddenModel);
			if (failure === "throw") throw new Error("未登录");
			return { result: async () => ({ stopReason: failure === "error" ? "error" : "stop", content: [] }) };
		};
		await h.commands.get("auto-name").handler("", h.ctx);
		assert.equal(h.pi.getSessionName(), "修复标题展示");
		assert.ok(notices.some((notice) => notice.type === "warning" && /输入摘要/.test(notice.message)), "必须说明这是失败后的兜底名称");
	}
});

test("未配置时使用当前模型且不改变主会话设置，非 TUI 无法打开设置界面", async () => {
	const h = createHarness();
	const requests = mockModelSelection(h);
	h.ctx.model = hiddenModel;
	h.pi.setModel = () => assert.fail("不能切换主模型");
	h.pi.setThinkingLevel = () => assert.fail("不能改变主会话思考级别");
	await h.commands.get("auto-name").handler("", h.ctx);
	assert.equal(requests[0].model, hiddenModel);
	assert.equal(requests[0].options.reasoning, undefined);
	await h.commands.get("auto-name-settings").handler("", h.ctx);
	const rpc = createHarness("rpc");
	rpc.ctx.ui.custom = () => assert.fail("RPC 不应打开 TUI");
	await rpc.commands.get("auto-name-settings").handler("", rpc.ctx);
});

test("模型搜索界面支持焦点、上下键、Esc 取消和无匹配时不确认", async () => {
	const h = createHarness();
	mockModelSelection(h);
	h.ctx.ui.notify = (message: string, type: string) => { if (type === "error") assert.fail(message); };
	h.ctx.modelRegistry.getAll = () => Array.from({ length: 30 }, (_, i) => ({ ...hiddenModel, id: `model-${i}` }));
	h.ctx.ui.custom = async (factory: any) => {
		let result: any = "not-finished";
		const component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, getKeybindings(), (value: any) => { result = value; });
		component.focused = true;
		assert.equal(component.focused, true);
		assert.ok(component.render(80).length < 16);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[A");
		component.handleInput("不存在的模型");
		component.handleInput("\r");
		assert.equal(result, "not-finished");
		component.invalidate();
		for (const line of component.render(20)) assert.ok(visibleWidth(line) <= 20);
		component.handleInput("\x1b");
		assert.equal(result, undefined);
		return result;
	};
	await h.commands.get("auto-name-settings").handler("", h.ctx);
});

test("恢复会话后在上边框右侧显示名称，保留编辑器对象与输入内容", async () => {
	const h = createHarness();
	await h.emit("session_start");
	const editor = h.createEditor();
	assert.equal(editor, h.base);
	const lines = editor.render(40);
	assert.match(stripTerminalSequences(lines[0]), / 已有会话 ─$/);
	assert.equal(visibleWidth(lines[0]), 40);
	assert.equal(lines[1], "草稿");
	assert.equal(lines[2], "─".repeat(40));
});

test("手动改名立即请求刷新，清空名称恢复边框，关闭后不再刷新旧界面", async () => {
	const h = createHarness();
	await h.emit("session_start");
	const editor = h.createEditor();
	h.pi.setSessionName("最新名称");
	assert.equal(h.renders, 1);
	assert.match(stripTerminalSequences(editor.render(40)[0]), / 最新名称 ─$/);
	h.pi.setSessionName(undefined);
	assert.equal(stripTerminalSequences(editor.render(40)[0]), "─".repeat(40));
	await h.emit("session_shutdown");
	const before = h.renders;
	h.pi.setSessionName("旧会话");
	assert.equal(h.renders, before);
});

test("长中文和 emoji 标题在窄窗口内截断，不覆盖左侧工作状态和滚动提示", async () => {
	const h = createHarness("tui", "中文标题😀很长很长很长很长");
	h.base.render = (width: number) => ["工作中 ↑ 2 more " + "─".repeat(Math.max(0, width - 16)), "草稿", "─".repeat(width)];
	await h.emit("session_start");
	const editor = h.createEditor();
	for (const width of [18, 25, 40, 80]) {
		const line = editor.render(width)[0];
		assert.ok(visibleWidth(line) <= width);
		assert.ok(stripTerminalSequences(line).startsWith("工作中 ↑ 2 more "));
	}
});

test("无名称和极窄窗口保持原始边框", async () => {
	const h = createHarness("tui", "");
	await h.emit("session_start");
	const editor = h.createEditor();
	assert.equal(editor.render(40)[0], "─".repeat(40));
	h.pi.setSessionName("中文标题");
	for (const width of [0, 1, 2, 3, 4]) assert.equal(editor.render(width)[0], "─".repeat(width));
});

test("真实默认编辑器可渲染标题，外层双 Esc 包装不丢失标题和快捷键", async () => {
	const h = createHarness();
	h.ctx.ui.getEditorComponent = () => undefined;
	await h.emit("session_start");
	const base = h.factory(
		{ terminal: { rows: 24 }, requestRender() {} },
		{ borderColor: (value: string) => value },
		{ matches: () => false },
	);
	const editor = new DoubleEscapeEditor(base, { isIdle: () => true, openRewind() {} });
	editor.setText("中文草稿");
	assert.match(stripTerminalSequences(editor.render(40)[0]), / 已有会话 ─$/);
	assert.equal(editor.getText(), "中文草稿");
	assert.equal(editor.actionHandlers, base.actionHandlers);
	h.pi.setSessionName("改名之后");
	assert.match(stripTerminalSequences(editor.render(40)[0]), / 改名之后 ─$/);
});

test("RPC 和 print 模式不替换终端编辑器", async () => {
	for (const mode of ["rpc", "print", "json"]) {
		const h = createHarness(mode);
		await h.emit("session_start");
		assert.equal(h.factory, h.previous);
	}
});

test("auto-name 重新命名同步更新标题，保留原有生成逻辑", async () => {
	const h = createHarness();
	await h.emit("session_start");
	const editor = h.createEditor();
	await h.commands.get("auto-name").handler("", h.ctx);
	assert.match(stripTerminalSequences(editor.render(40)[0]), / 修复标题展示 ─$/);
	assert.equal(h.renders, 1);
});

test("首条用户消息触发自动命名并同步刷新标题，已有名称不被覆盖", async () => {
	const h = createHarness("tui", "");
	await h.emit("session_start");
	const editor = h.createEditor();
	await h.emit("before_agent_start", { messageType: "user", prompt: "修复标题展示" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(stripTerminalSequences(editor.render(40)[0]), / 修复标题展示 ─$/);
	h.pi.setSessionName("手动名称");
	await h.emit("before_agent_start", { messageType: "user", prompt: "继续修改" });
	assert.equal(h.pi.getSessionName(), "手动名称");
});

test("用户提交后立即启动命名，无需消息落盘或等待回答，也不阻塞主流程", async () => {
	const h = createHarness("tui", "");
	const requests = mockModelSelection(h);
	h.ctx.model = hiddenModel;
	h.ctx.sessionManager.getBranch = () => [];
	let resolveName!: (value: any) => void;
	const pending = new Promise((resolve) => { resolveName = resolve; });
	const stream = h.ctx.modelRegistry.streamSimple;
	h.ctx.modelRegistry.streamSimple = (...args: any[]) => {
		stream(...args);
		return { result: () => pending };
	};
	let returned = false;
	const event = h.emit("before_agent_start", { messageType: "user", prompt: "优化数据库查询" }).then(() => { returned = true; });
	await new Promise((resolve) => setImmediate(resolve));
	try {
		assert.equal(requests.length, 1, "回答开始前必须发出命名请求");
		assert.match(requests[0].context.messages[0].content[0].text, /优化数据库查询/);
		assert.equal(returned, true, "事件不能等待命名完成");
		assert.equal(h.pi.getSessionName(), "");
	} finally {
		resolveName({ stopReason: "stop", content: [{ type: "text", text: "优化数据库查询" }] });
		await event;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.equal(h.pi.getSessionName(), "优化数据库查询");
	await h.emit("before_agent_start", { messageType: "user", prompt: "第二条消息" });
	await h.emit("agent_settled", { aborted: false });
	assert.equal(requests.length, 1, "后续输入与回答结束不得重复命名");
});

test("后台命名期间手动改名或切换会话，不写入过期标题", async () => {
	for (const action of ["manual", "switch", "shutdown"]) {
		const h = createHarness("tui", "");
		mockModelSelection(h);
		h.ctx.model = hiddenModel;
		let finish!: (value: any) => void;
		h.ctx.modelRegistry.streamSimple = () => ({ result: () => new Promise((resolve) => { finish = resolve; }) });
		await h.emit("before_agent_start", { messageType: "user", prompt: "修复标题展示" });
		assert.equal(typeof finish, "function");
		if (action === "manual") h.pi.setSessionName("手动标题");
		if (action === "switch") h.ctx.sessionManager.getSessionId = () => "session-2";
		if (action === "shutdown") await h.emit("session_shutdown");
		finish({ stopReason: "stop", content: [{ type: "text", text: "过期标题" }] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(h.pi.getSessionName(), action === "manual" ? "手动标题" : "");
	}
});

test("模型长标题在自动命名和重新命名后完整保存，窄窗口只省略显示", async () => {
	const title = "auto-session-name 与 DoubleEscapeEditor 会话标题显示兼容性";
	for (const trigger of ["auto", "command"]) {
		const h = createHarness("tui", "");
		mockModelSelection(h);
		h.ctx.model = hiddenModel;
		h.ctx.modelRegistry.streamSimple = () => ({
			result: async () => ({ stopReason: "stop", content: [{ type: "text", text: title }] }),
		});
		await h.emit("session_start");
		const editor = h.createEditor();
		if (trigger === "auto") {
			await h.emit("before_agent_start", { messageType: "user", prompt: "调整会话标题" });
			await new Promise((resolve) => setImmediate(resolve));
		} else {
			await h.commands.get("auto-name").handler("", h.ctx);
		}
		assert.equal(h.pi.getSessionName(), title);
		const narrow = stripTerminalSequences(editor.render(30)[0]);
		assert.ok(visibleWidth(narrow) <= 30);
		assert.match(narrow, /\.\.\./);
		assert.equal(h.pi.getSessionName(), title, "显示省略不能改变保存的名称");
		assert.ok(stripTerminalSequences(editor.render(120)[0]).includes(title));
	}
});

test("标题保留 200 码点安全上限，清洗前缀引号和结尾标点且不拆开 emoji 码点", async () => {
	const h = createHarness();
	mockModelSelection(h);
	h.ctx.model = hiddenModel;
	for (const title of ["中文主题", "😀".repeat(200), "😀".repeat(201)]) {
		h.ctx.modelRegistry.streamSimple = () => ({
			result: async () => ({ stopReason: "stop", content: [{ type: "text", text: `\n标题：“${title}。”\n多余解释` }] }),
		});
		await h.commands.get("auto-name").handler("", h.ctx);
		assert.equal(h.pi.getSessionName(), title === "中文主题" ? title : "😀".repeat(200));
	}
});

test("模型失败仍用前 24 字符加省略号作为输入摘要，不因标题上限放宽而变长", async () => {
	const h = createHarness();
	const input = "甲".repeat(24) + "不应保留的后文";
	h.ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "user", content: input } }];
	await h.commands.get("auto-name").handler("", h.ctx);
	assert.equal(h.pi.getSessionName(), "甲".repeat(24) + "…");
});

test("自定义消息和空白输入不触发自动命名", async () => {
	const h = createHarness("tui", "");
	const requests = mockModelSelection(h);
	h.ctx.model = hiddenModel;
	await h.emit("before_agent_start", { messageType: "custom", message: {} });
	await h.emit("before_agent_start", { messageType: "user", prompt: "  " });
	assert.equal(requests.length, 0);
	await h.emit("before_agent_start", { messageType: "user", prompt: "修复标题展示" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests.length, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, InteractiveMode, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";

import responseTimer from "../.pi/extensions/response-timer.ts";
import { DoubleEscapeEditor } from "../.pi/extensions/rewind-claude/double-escape-editor.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

interface AppendedEntry {
    customType: string;
    data: unknown;
}

function registerExtension(appendedEntries: AppendedEntry[] = [], registeredCommands: string[] = []) {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
        on(name: string, handler: (...args: any[]) => unknown) {
            handlers.set(name, handler);
        },
        registerCommand(name: string) {
            registeredCommands.push(name);
        },
        registerEntryRenderer() {
            // Entry 的具体视觉渲染由 Pi TUI 负责，这里只验证持久化行为。
        },
        appendEntry(customType: string, data: unknown) {
            appendedEntries.push({ customType, data });
        },
    };
    responseTimer(pi as never);
    return handlers;
}

function createContext(workingVisibility: boolean[]) {
    return {
        ui: {
            theme: {
                fg: (_color: string, text: string) => text,
            },
            setWorkingVisible: (visible: boolean) => workingVisibility.push(visible),
            setWorkingIndicator: () => {},
        },
    };
}

function createEditorContext() {
    initTheme("dark");
    const ctx = createContext([]);
    const base = {
        render: (_width: number) => ["EDITOR"],
        invalidate() {},
        handleInput(_data: string) {},
        getText: () => "draft",
        setText(_text: string) {},
        focused: false,
    };
    let factory: EditorFactory = () => base;
    let editor = base;
    const tui = { requestRender() {} };
    // 直接使用 Pi 的 widget 布局路径，覆盖 todo 在运行中新增和更新的情况。
    const layout = Object.assign(Object.create(InteractiveMode.prototype), {
        extensionWidgetsAbove: new Map(),
        extensionWidgetsBelow: new Map(),
        widgetContainerAbove: new Container(),
        widgetContainerBelow: new Container(),
        ui: tui,
    });
    return {
        ...ctx,
        mode: "tui",
        base,
        get editor() { return editor; },
        render: (width = 80): string[] => [
            ...layout.widgetContainerAbove.render(width),
            ...editor.render(width),
        ],
        ui: {
            ...ctx.ui,
            getEditorComponent: () => factory,
            setEditorComponent(next: EditorFactory) {
                factory = next;
                editor = next(tui as never, {} as never, {} as never) as typeof base;
            },
            setWidget: layout.setExtensionWidget.bind(layout),
        },
    };
}

test("todo 在计时开始后新增或更新，计时器仍紧贴输入框", async () => {
    const handlers = registerExtension();
    const ctx = createEditorContext();
    try {
        await handlers.get("session_start")?.({ type: "session_start" }, ctx);
        await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
        for (const text of ["TODO initial", "TODO updated"]) {
            ctx.ui.setWidget("todo", [text]);
            const lines = ctx.render();
            assert.match(lines.at(-2)!, /Working\.\.\./);
            assert.equal(lines.at(-1), "EDITOR");
            assert.ok(lines.some((line) => line.includes(text)));
        }
        await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
        assert.ok(!ctx.render().some((line) => line.includes("Working...")));
    } finally {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    }
});

test("不再注册 timer-stats 命令", async () => {
    const registeredCommands: string[] = [];
    const handlers = registerExtension([], registeredCommands);
    const ctx = createContext([]);

    try {
        assert.equal(registeredCommands.includes("timer-stats"), false);
    } finally {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    }
});

test("运行期间隐藏 Pi 内建 Working 行，结束后恢复", async () => {
    const handlers = registerExtension();
    const workingVisibility: boolean[] = [];
    const ctx = createContext(workingVisibility);

    try {
        await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
        assert.deepEqual(workingVisibility, [false]);

        await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
        assert.deepEqual(workingVisibility, [false, true]);
    } finally {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    }
});

test("运行中计时器紧靠输入框上方，结束后清除", async () => {
    const handlers = registerExtension();
    const ctx = createEditorContext();

    try {
        await handlers.get("session_start")?.({ type: "session_start" }, ctx);
        assert.deepEqual(ctx.render(), ["EDITOR"]);
        await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
        assert.match(ctx.render()[0]!, /Working\.\.\./);
        assert.equal(ctx.render()[1], "EDITOR");
        await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
        assert.deepEqual(ctx.render(), ["EDITOR"]);
    } finally {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    }
});

test("窄终端中的运行计时器不会超过可用宽度", async () => {
    const handlers = registerExtension();
    const ctx = createEditorContext();

    try {
        await handlers.get("session_start")?.({ type: "session_start" }, ctx);
        await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
        const [line] = ctx.render(34);

        assert.ok(line);
        assert.ok(visibleWidth(line) <= 34, `计时器宽度 ${visibleWidth(line)} 超过终端宽度 34`);
    } finally {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    }
});

test("重复 session_start 与 Rewind 编辑器组合后只显示一条计时行", async () => {
    const handlers = registerExtension();
    const ctx = createEditorContext();
    try {
        await handlers.get("session_start")?.({ type: "session_start" }, ctx);
        const previous = ctx.ui.getEditorComponent();
        ctx.ui.setEditorComponent((tui, theme, keys) => new DoubleEscapeEditor(previous(tui, theme, keys), {
            isIdle: () => false,
            openRewind() {},
        }));
        await handlers.get("session_start")?.({ type: "session_start" }, ctx);
        await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
        assert.equal(ctx.render().filter((line) => line.includes("Working...")).length, 1);
        ctx.editor.focused = true;
        assert.equal(ctx.base.focused, true);
        assert.equal(ctx.editor.getText(), "draft");
    } finally {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    }
});

test("编辑器装饰保留原有输入方法与快捷键", async (t) => {
    const handlers = registerExtension();
    const ctx = createEditorContext();
    const input = t.mock.method(ctx.base, "handleInput");
    try {
        await handlers.get("session_start")?.({ type: "session_start" }, ctx);
        assert.equal(ctx.editor, ctx.base);
        ctx.editor.handleInput("\u001b");
        assert.equal(input.mock.calls[0]?.arguments[0], "\u001b");
        await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
        await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
        assert.deepEqual(ctx.render(), ["EDITOR"]);
    } finally {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    }
});

test("每轮结束后都将耗时追加到对话历史", async () => {
    const appendedEntries: AppendedEntry[] = [];
    const handlers = registerExtension(appendedEntries);
    const ctx = createContext([]);

    try {
        for (let index = 0; index < 2; index++) {
            await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
            await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
        }

        assert.equal(appendedEntries.length, 2);
        assert.deepEqual(
            appendedEntries.map((entry) => entry.customType),
            ["response-timer-history", "response-timer-history"],
        );
        for (const entry of appendedEntries) {
            assert.equal(typeof (entry.data as { duration?: unknown }).duration, "number");
        }
    } finally {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    }
});

test("项目版与全局版重复加载时只记录一次耗时", async () => {
    const appendedEntries: AppendedEntry[] = [];
    const firstHandlers = registerExtension(appendedEntries);
    const secondHandlers = registerExtension(appendedEntries);
    const ctx = createContext([]);

    try {
        for (const handlers of [firstHandlers, secondHandlers]) {
            await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
        }
        for (const handlers of [firstHandlers, secondHandlers]) {
            await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
        }

        assert.equal(appendedEntries.length, 1);
    } finally {
        await firstHandlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
        await secondHandlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    }
});

import assert from "node:assert/strict";
import test from "node:test";

import { DoubleEscapeEditor } from "./double-escape-editor.ts";

class FakeCustomEditor {
    text: string;
    inputs: string[] = [];
    history: string[] = [];
    actionHandlers = new Map<string, () => void>();
    onEscape?: () => void;
    onCtrlD?: () => void;
    onPasteImage?: () => void;
    onExtensionShortcut?: (data: string) => boolean | void;

    constructor(text: string) {
        this.text = text;
    }

    render(): string[] { return []; }
    invalidate(): void {}
    handleInput(data: string): void {
        this.inputs.push(data);
        if (data === "\u0003") this.actionHandlers.get("app.clear")?.();
        if (data === "\u001b[A") this.text = this.history[0] ?? this.text;
    }
    getText(): string { return this.text; }
    getExpandedText(): string { return this.text; }
    setText(text: string): void { this.text = text; }
    addToHistory(text: string): void {
        const trimmed = text.trim();
        if (!trimmed || this.history[0] === trimmed) return;
        this.history.unshift(trimmed);
    }
}

function createEditor(text: string) {
    const base = new FakeCustomEditor(text);
    const editor = new DoubleEscapeEditor(base as any, {
        isIdle: () => true,
        openRewind: () => {},
    });
    return { base, editor };
}

test("包装层暴露底层 CustomEditor 的 actionHandlers，供 Pi 注入原生 app.clear", () => {
    const { base, editor } = createEditor("草稿");
    assert.equal((editor as any).actionHandlers, base.actionHandlers);

    let calls = 0;
    (editor as any).actionHandlers.set("app.clear", () => { calls++; });
    editor.handleInput("\u0003");

    assert.equal(calls, 1);
    assert.deepEqual(base.inputs, ["\u0003"]);
});

test("包装层透传 Pi 原生 Ctrl+C：第一次清空，500ms 内第二次退出", () => {
    const { base, editor } = createEditor("草稿");
    let now = 1000;
    let lastPress = 0;
    let exits = 0;
    base.actionHandlers.set("app.clear", () => {
        if (now - lastPress < 500) exits++;
        else {
            base.setText("");
            lastPress = now;
        }
    });

    editor.handleInput("\u0003");
    now += 200;
    editor.handleInput("\u0003");

    assert.equal(base.text, "");
    assert.equal(exits, 1);
});

test("Session 替换后新 Editor 仍可通过上键访问原输入历史", () => {
    const promptHistory: string[] = [];
    const firstBase = new FakeCustomEditor("");
    const firstEditor = new DoubleEscapeEditor(firstBase as any, {
        isIdle: () => true,
        openRewind: () => {},
        promptHistory,
    });
    firstEditor.addToHistory("第一条输入");
    firstEditor.addToHistory("第二条输入");

    // rewind 会销毁旧 Editor；新 Session 只能通过共享状态恢复输入历史。
    const secondBase = new FakeCustomEditor("");
    const secondEditor = new DoubleEscapeEditor(secondBase as any, {
        isIdle: () => true,
        openRewind: () => {},
        promptHistory,
    });
    secondEditor.handleInput("\u001b[A");

    assert.equal(secondEditor.getText(), "第二条输入");
});

test("包装层代理 CustomEditor 特殊 handler，保留退出、中断和粘贴行为", () => {
    const { base, editor } = createEditor("");
    const onEscape = () => {};
    const onCtrlD = () => {};
    const onPasteImage = () => {};
    const onExtensionShortcut = () => true;

    (editor as any).onEscape = onEscape;
    (editor as any).onCtrlD = onCtrlD;
    (editor as any).onPasteImage = onPasteImage;
    (editor as any).onExtensionShortcut = onExtensionShortcut;

    assert.equal(base.onEscape, onEscape);
    assert.equal(base.onCtrlD, onCtrlD);
    assert.equal(base.onPasteImage, onPasteImage);
    assert.equal(base.onExtensionShortcut, onExtensionShortcut);
});

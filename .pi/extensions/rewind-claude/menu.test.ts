import assert from "node:assert/strict";
import test from "node:test";

import { stripTerminalSequences } from "@earendil-works/pi-tui";

const menu = await import("./menu.ts").catch(() => ({} as Record<string, unknown>));

const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    dim: (text: string) => text,
} as any;

function options() {
    return {
        theme,
        onDone: () => {},
        requestRender: () => {},
    };
}

function plain(lines: string[]): string[] {
    return lines.map((line) => stripTerminalSequences(line));
}

test("回退点按时间正序显示，并将 current 作为默认选中的独立末项", () => {
    assert.equal(typeof menu.RewindPointMenu, "function", "应提供 RewindPointMenu");
    const Menu = menu.RewindPointMenu as new (options: any) => {
        render(width: number): string[];
        handleInput(data: string): void;
    };
    const component = new Menu({
        ...options(),
        items: [
            {
                value: "point-1",
                label: "第一次修改",
                changes: [{ path: "hello.html", additions: 1, deletions: 1 }],
            },
            {
                value: "point-2",
                label: "第二次修改",
                changes: [{ path: "hello.html", additions: 2, deletions: 0 }],
            },
        ],
    });

    assert.deepEqual(plain(component.render(100)), [
        "─".repeat(100),
        "  Rewind",
        "",
        "  Restore the code and/or conversation to the point before…",
        "",
        "    第一次修改",
        "    hello.html +1 -1",
        "",
        "    第二次修改",
        "    hello.html +2 -0",
        "",
        "  ❯ (current)",
        "",
        "",
        "  Enter to continue · Esc to cancel",
    ]);

    component.handleInput("\u001b[A");
    const selected = component.render(100);
    assert.equal(plain(selected)[8], "  ❯ 第二次修改");
    assert.equal(
        selected[8],
        "  \u001b[1m\u001b[38;2;87;105;247m❯ \u001b[0m\u001b[38;2;87;105;247m第二次修改\u001b[39m",
    );
    assert.doesNotMatch(selected[8] ?? "", /\u001b\[48;/);
});

test("从确认页返回时恢复之前选中的 point", () => {
    const Menu = menu.RewindPointMenu as new (options: any) => { render(width: number): string[] };
    const rendered = plain(new Menu({
        ...options(),
        initialValue: "point-2",
        items: [
            { value: "point-1", label: "第一项", changes: [] },
            { value: "point-2", label: "第二项", changes: [] },
        ],
    }).render(80)).join("\n");

    assert.match(rendered, /❯ 第二项/);
    assert.doesNotMatch(rendered, /❯ \(current\)/);
});

test("列表页最多显示七项，并让选中项保持在可视窗口中", () => {
    const Menu = menu.RewindPointMenu as new (options: any) => {
        render(width: number): string[];
        handleInput(data: string): void;
    };
    const component = new Menu({
        ...options(),
        items: Array.from({ length: 9 }, (_, index) => ({
            value: `point-${index + 1}`,
            label: `第${index + 1}项`,
            changes: [],
        })),
    });

    let rendered = plain(component.render(80)).join("\n");
    assert.doesNotMatch(rendered, /第[123]项/);
    assert.match(rendered, /第4项/);
    assert.match(rendered, /第9项/);
    assert.match(rendered, /\(current\)/);

    for (let index = 0; index < 5; index++) component.handleInput("\u001b[A");
    rendered = plain(component.render(80)).join("\n");
    assert.match(rendered, /第2项/);
    assert.match(rendered, /第8项/);
    assert.doesNotMatch(rendered, /第9项|\(current\)/);
});

test("列表页按 Claude Code 规则显示无变化、多文件和不可恢复状态", () => {
    const Menu = menu.RewindPointMenu as new (options: any) => { render(width: number): string[] };
    const rendered = plain(new Menu({
        ...options(),
        items: [
            { value: "none", label: "无修改", changes: [] },
            {
                value: "multiple",
                label: "多文件",
                changes: [
                    { path: "src/a.ts", additions: 2, deletions: 1 },
                    { path: "src/b.ts", additions: 3, deletions: 4 },
                ],
            },
            { value: "legacy", label: "旧检查点", changes: undefined },
        ],
    }).render(100)).join("\n");

    assert.match(rendered, /No code changes/);
    assert.match(rendered, /2 files changed \+5 -5/);
    assert.match(rendered, /⚠ No code restore/);
    assert.doesNotMatch(rendered, /src\/a\.ts|src\/b\.ts/);
});

test("列表页使用 Claude Code 实测的选中、文件、加减颜色", () => {
    const Menu = menu.RewindPointMenu as new (options: any) => { render(width: number): string[] };
    const lines = new Menu({
        ...options(),
        items: [{
            value: "point-1",
            label: "修改文件",
            changes: [{ path: "hello.html", additions: 1, deletions: 2 }],
        }],
    }).render(80);
    const divider = lines[0] ?? "";
    const file = lines[6] ?? "";
    const current = lines[8] ?? "";

    assert.match(divider, /\u001b\[38;2;87;105;247m/);
    assert.match(file, /\u001b\[38;5;246mhello\.html/);
    assert.match(file, /\u001b\[38;5;72m\+1/);
    assert.match(file, /\u001b\[38;5;174m-2/);
    assert.match(current, /\u001b\[38;2;87;105;247m/);
    assert.match(lines[1] ?? "", /\u001b\[38;2;87;105;247mRewind/);
});

test("确认菜单显示当前动作影响、恢复统计和手动文件警告", () => {
    assert.equal(typeof menu.RewindConfirmationMenu, "function", "应提供 RewindConfirmationMenu");
    const Menu = menu.RewindConfirmationMenu as new (options: any) => { render(width: number): string[] };
    const component = new Menu({
        ...options(),
        prompt: "将hello.html里面的hello world改为hello",
        createdAt: "2026-08-28T00:04:00.000Z",
        now: () => new Date("2026-08-28T00:07:00.000Z"),
        changes: [{ path: "hello.html", additions: 1, deletions: 1 }],
        items: [
            { value: "restore-both", label: "Restore code and conversation" },
            { value: "restore-conversation", label: "Restore conversation" },
            { value: "restore-code", label: "Restore code" },
            { value: "summarize-from", label: "Summarize from here", acceptsContext: true },
            { value: "summarize-up-to", label: "Summarize up to here", acceptsContext: true },
            { value: "never-mind", label: "Never mind" },
        ],
    });

    const lines = component.render(100);
    assert.deepEqual(plain(lines), [
        "─".repeat(100),
        "  Rewind",
        "",
        "  Confirm you want to restore to the point before you sent this message:",
        "",
        "  │ 将hello.html里面的hello world改为hello",
        "  │ (3m ago)",
        "",
        "  The conversation will be forked.",
        "  The code will be restored +1 -1 in hello.html.",
        "",
        "  ❯ 1. Restore code and conversation",
        "    2. Restore conversation",
        "    3. Restore code",
        "    4. Summarize from here",
        "    5. Summarize up to here",
        "  ↓ 6. Never mind",
        "",
        "  ⚠ Rewinding does not affect files edited manually or via bash.",
        "",
    ]);
    assert.match(lines[9] ?? "", /\u001b\[38;5;72m\+1/);
    assert.match(lines[9] ?? "", /\u001b\[38;5;174m-1/);
    assert.match(lines[11] ?? "", /\u001b\[38;2;87;105;247mRestore code and conversation/);
    assert.doesNotMatch(lines[11] ?? "", /\u001b\[48;/);
});

test("确认菜单随选中动作更新 conversation 和 code 说明", () => {
    const Menu = menu.RewindConfirmationMenu as new (options: any) => {
        render(width: number): string[];
        handleInput(data: string): void;
    };
    const component = new Menu({
        ...options(),
        prompt: "修改文件",
        createdAt: "2026-08-28T00:04:00.000Z",
        now: () => new Date("2026-08-28T00:07:00.000Z"),
        changes: [{ path: "src/hello.html", additions: 3, deletions: 2 }],
        items: [
            { value: "restore-both", label: "Restore code and conversation", description: "The conversation will be forked." },
            { value: "restore-conversation", label: "Restore conversation", description: "The conversation will be forked." },
            { value: "restore-code", label: "Restore code", description: "The conversation will be unchanged." },
            { value: "summarize-from", label: "Summarize from here", description: "Messages after this point will be summarized.", acceptsContext: true },
        ],
    });

    component.handleInput("\u001b[B");
    let rendered = plain(component.render(100)).join("\n");
    assert.match(rendered, /The conversation will be forked\./);
    assert.match(rendered, /The code will be unchanged\./);
    assert.doesNotMatch(rendered, /The code will be restored/);

    component.handleInput("\u001b[B");
    rendered = plain(component.render(100)).join("\n");
    assert.match(rendered, /The conversation will be unchanged\./);
    assert.match(rendered, /The code will be restored \+3 -2 in hello\.html\./);

    component.handleInput("\u001b[B");
    rendered = plain(component.render(100)).join("\n");
    assert.match(rendered, /Messages after this point will be summarized\./);
    assert.doesNotMatch(rendered, /The code will be/);
});

test("确认菜单没有代码变更时不显示手动文件警告", () => {
    const Menu = menu.RewindConfirmationMenu as new (options: any) => { render(width: number): string[] };
    const rendered = plain(new Menu({
        ...options(),
        prompt: "仅对话",
        createdAt: "2026-08-28T00:04:00.000Z",
        now: () => new Date("2026-08-28T00:07:00.000Z"),
        changes: [],
        items: [{
            value: "restore-conversation",
            label: "Restore conversation",
            description: "The conversation will be forked.",
        }],
    }).render(100)).join("\n");

    assert.match(rendered, /restore the conversation to the point before/);
    assert.doesNotMatch(rendered, /edited manually or via bash/);
});

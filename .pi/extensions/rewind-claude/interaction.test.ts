import assert from "node:assert/strict";
import test from "node:test";

const interaction = await import("./interaction.ts").catch(() => ({} as Record<string, unknown>));

test("动作菜单：存在代码变更时按 Claude Code 顺序显示六项", () => {
    assert.equal(typeof interaction.buildActionOptions, "function", "应提供 buildActionOptions");
    const options = (interaction.buildActionOptions as (hasChanges: boolean) => Array<{ value: string }>)(true);
    assert.deepEqual(options.map((item) => item.value), [
        "restore-both",
        "restore-conversation",
        "restore-code",
        "summarize-from",
        "summarize-up-to",
        "never-mind",
    ]);
});

test("会话恢复动作使用真正 Fork，代码恢复和摘要动作不切换 Session", () => {
    assert.equal(typeof interaction.shouldForkConversation, "function", "应提供 shouldForkConversation");
    const shouldFork = interaction.shouldForkConversation as (action: string) => boolean;
    assert.equal(shouldFork("restore-both"), true);
    assert.equal(shouldFork("restore-conversation"), true);
    assert.equal(shouldFork("restore-code"), false);
    assert.equal(shouldFork("summarize-from"), false);
    assert.equal(shouldFork("summarize-up-to"), false);
});

test("动作菜单：没有代码变更时隐藏两个代码恢复入口", () => {
    const options = (interaction.buildActionOptions as (hasChanges: boolean) => Array<{ value: string }>)(false);
    assert.deepEqual(options.map((item) => item.value), [
        "restore-conversation",
        "summarize-from",
        "summarize-up-to",
        "never-mind",
    ]);
});

test("动作菜单：选项说明与 Claude Code 当前选择的影响一致", () => {
    const options = (interaction.buildActionOptions as (hasChanges: boolean) => Array<{
        value: string;
        description: string;
    }>)(true);
    assert.deepEqual(
        Object.fromEntries(options.map((item) => [item.value, item.description])),
        {
            "restore-both": "The conversation will be forked.",
            "restore-conversation": "The conversation will be forked.",
            "restore-code": "The conversation will be unchanged.",
            "summarize-from": "Messages after this point will be summarized.",
            "summarize-up-to": "Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.",
            "never-mind": "The conversation will be unchanged.",
        },
    );
});

test("确认页取消或选择 Never mind 时返回 point 列表", async () => {
    assert.equal(typeof interaction.chooseRewindAction, "function", "应提供 chooseRewindAction");
    const choose = interaction.chooseRewindAction as (
        pickPoint: () => Promise<{ value: string } | null>,
        pickAction: (point: { value: string }) => Promise<{ value: string } | null>,
    ) => Promise<{ point: { value: string }; action: { value: string } } | null>;
    const points = [{ value: "point-1" }, { value: "point-1" }, { value: "point-2" }];
    const actions = [null, { value: "never-mind" }, { value: "restore-conversation" }];
    let pointCalls = 0;
    let actionCalls = 0;

    const result = await choose(
        async () => points[pointCalls++] ?? null,
        async () => actions[actionCalls++] ?? null,
    );

    assert.deepEqual(result, {
        point: { value: "point-2" },
        action: { value: "restore-conversation" },
    });
    assert.equal(pointCalls, 3);
});

test("用户在 point 列表取消时关闭 Rewind", async () => {
    const choose = interaction.chooseRewindAction as (
        pickPoint: () => Promise<null>,
        pickAction: () => Promise<{ value: string } | null>,
    ) => Promise<unknown>;
    let actionCalled = false;
    const result = await choose(async () => null, async () => {
        actionCalled = true;
        return { value: "restore-code" };
    });
    assert.equal(result, null);
    assert.equal(actionCalled, false);
});

test("用户消息后存在 custom entry 时仍能找到对应 user entry", () => {
    assert.equal(typeof interaction.findUserEntryForMessage, "function", "应提供 findUserEntryForMessage");
    const message = { role: "user", content: "hello", timestamp: 123 };
    const entries = [
        { type: "message", id: "user-entry", message },
        { type: "custom", id: "logger-entry", customType: "logger", data: {} },
    ];
    const findEntry = interaction.findUserEntryForMessage as (entries: unknown[], message: unknown) => { id: string } | undefined;
    assert.equal(findEntry(entries, message)?.id, "user-entry");
});

test("回退到消息 3 后，输入历史仅保留消息 2、1", () => {
    assert.equal(typeof interaction.buildPromptHistoryBefore, "function", "应提供 buildPromptHistoryBefore");
    const buildHistory = interaction.buildPromptHistoryBefore as (
        entries: unknown[],
        targetEntryId: string,
    ) => string[];
    const entries = ["1", "2", "3", "4"].map((content, index) => ({
        type: "message",
        id: `user-${index + 1}`,
        message: { role: "user", content },
    }));

    assert.deepEqual(buildHistory(entries, "user-3"), ["2", "1"]);
});

test("回退后仅保留当前活动分支，所选 point 和后续 point 都不再出现", () => {
    assert.equal(typeof interaction.selectActiveCheckpoints, "function", "应提供 selectActiveCheckpoints");
    const select = interaction.selectActiveCheckpoints as (
        checkpoints: Array<{ id: string; userEntryId: string }>,
        entries: Array<{ id: string }>,
    ) => Array<{ id: string }>;
    // Pi 导航到 user entry 时 leaf 会落在它的 parent，因此所选 point 也必须退出列表。
    const result = select(
        [
            { id: "first", userEntryId: "user-1" },
            { id: "second", userEntryId: "user-2" },
            { id: "abandoned", userEntryId: "user-3" },
        ],
        [{ id: "user-1" }],
    );
    assert.deepEqual(result, [
        { id: "first", userEntryId: "user-1" },
    ]);
});

test("Prompt 文本提取支持字符串和文本块", () => {
    assert.equal(typeof interaction.getUserPromptText, "function", "应提供 getUserPromptText");
    const getText = interaction.getUserPromptText as (message: unknown) => string;
    assert.equal(getText({ role: "user", content: "hello" }), "hello");
    assert.equal(getText({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
    assert.equal(getText({ role: "assistant", content: [] }), "");
});

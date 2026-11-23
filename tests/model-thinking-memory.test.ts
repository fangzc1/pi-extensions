import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    createModelThinkingMemoryExtension,
    JsonModelThinkingMemoryStore,
    type ModelThinkingMemoryStore,
    type ThinkingLevel,
} from "../.pi/extensions/model-thinking-memory.ts";

interface ModelRef {
    provider: string;
    id: string;
}

type Handler = (event: any, ctx: any) => unknown;

class MemoryStore implements ModelThinkingMemoryStore {
    readonly values = new Map<string, ThinkingLevel>();
    readonly writes: Array<{ modelKey: string; level: ThinkingLevel }> = [];
    lastModel: ModelRef | undefined;

    get(modelKey: string): ThinkingLevel | undefined {
        return this.values.get(modelKey);
    }

    set(modelKey: string, level: ThinkingLevel): void {
        this.values.set(modelKey, level);
        this.writes.push({ modelKey, level });
    }

    getLastModel(): ModelRef | undefined {
        return this.lastModel;
    }

    setLastModel(value: ModelRef): void {
        this.lastModel = value;
    }
}

function model(provider: string, id: string): ModelRef {
    return { provider, id };
}

function createHarness(
    store: MemoryStore,
    initialLevel: ThinkingLevel = "medium",
    availableModels: ModelRef[] = [],
    extension = createModelThinkingMemoryExtension(store),
) {
    const handlers = new Map<string, Handler>();
    const appliedLevels: ThinkingLevel[] = [];
    const appliedModels: ModelRef[] = [];
    let currentLevel = initialLevel;

    const pi = {
        on(name: string, handler: Handler) {
            handlers.set(name, handler);
        },
        getThinkingLevel() {
            return currentLevel;
        },
        setThinkingLevel(level: ThinkingLevel) {
            currentLevel = level;
            appliedLevels.push(level);
        },
        async setModel(value: ModelRef) {
            appliedModels.push(value);
            return true;
        },
    };

    extension(pi as never);

    return { handlers, appliedLevels, appliedModels, availableModels };
}

function createContext(
    activeModel: ModelRef,
    availableModels: ModelRef[] = [],
    entries: Array<{ type: string }> = [],
) {
    return {
        model: activeModel,
        modelRegistry: {
            find(provider: string, id: string) {
                return availableModels.find((value) => value.provider === provider && value.id === id);
            },
        },
        sessionManager: {
            getEntries() {
                return entries;
            },
        },
        ui: {
            notify() {
                // 测试不校验通知视觉效果。
            },
        },
    };
}

test("切换到有历史记录的模型时恢复该模型的 thinking level", async () => {
    const store = new MemoryStore();
    store.values.set("openai/gpt-5", "high");
    const { handlers, appliedLevels } = createHarness(store);

    await handlers.get("session_start")?.({}, createContext(model("anthropic", "claude-sonnet")));
    await handlers.get("model_select")?.(
        { model: model("openai", "gpt-5"), previousModel: model("anthropic", "claude-sonnet"), source: "set" },
        createContext(model("openai", "gpt-5")),
    );

    assert.deepEqual(appliedLevels, ["high"]);
});

test("切换到没有历史记录的模型时保留 Pi 默认 thinking level", async () => {
    const store = new MemoryStore();
    const { handlers, appliedLevels } = createHarness(store, "low");

    await handlers.get("session_start")?.({}, createContext(model("anthropic", "claude-sonnet")));
    await handlers.get("model_select")?.(
        { model: model("google", "gemini-pro"), previousModel: model("anthropic", "claude-sonnet"), source: "cycle" },
        createContext(model("google", "gemini-pro")),
    );

    assert.deepEqual(appliedLevels, []);
    assert.equal(store.get("google/gemini-pro"), undefined);
});

test("用户调整 thinking level 后按当前 provider/model 保存", async () => {
    const store = new MemoryStore();
    const { handlers } = createHarness(store);
    const activeModel = model("openrouter", "anthropic/claude-opus");
    const ctx = createContext(activeModel);

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("thinking_level_select")?.({ level: "max", previousLevel: "high" }, ctx);

    assert.deepEqual(store.writes, [
        { modelKey: "openrouter/anthropic/claude-opus", level: "max" },
    ]);
});

test("模型切换时 Pi 自动 clamp 的事件不会污染新模型的首次默认值", async () => {
    const store = new MemoryStore();
    const { handlers, appliedLevels } = createHarness(store, "high");
    const oldModel = model("anthropic", "claude-opus");
    const newModel = model("local", "non-reasoning");

    await handlers.get("session_start")?.({}, createContext(oldModel));

    // Pi 源码中 setModel 会先切换 ctx.model 并触发 clamp，之后才触发 model_select。
    await handlers.get("thinking_level_select")?.(
        { level: "off", previousLevel: "high" },
        createContext(newModel),
    );
    await handlers.get("model_select")?.(
        { model: newModel, previousModel: oldModel, source: "set" },
        createContext(newModel),
    );

    assert.equal(store.get("local/non-reasoning"), undefined);
    assert.deepEqual(appliedLevels, []);
});

test("启动时也会恢复当前模型的最近 thinking level", async () => {
    const store = new MemoryStore();
    store.values.set("anthropic/claude-opus", "xhigh");
    const { handlers, appliedLevels } = createHarness(store, "medium");

    await handlers.get("session_start")?.({}, createContext(model("anthropic", "claude-opus")));

    assert.deepEqual(appliedLevels, ["xhigh"]);
});

test("新建空会话时恢复最后一次手动选择的模型", async () => {
    const store = new MemoryStore();
    const selectedModel = model("openai", "gpt-5");
    const firstSession = createHarness(store);

    await firstSession.handlers.get("session_start")?.(
        { reason: "startup" },
        createContext(model("anthropic", "claude-sonnet")),
    );
    await firstSession.handlers.get("model_select")?.(
        {
            model: selectedModel,
            previousModel: model("anthropic", "claude-sonnet"),
            source: "set",
        },
        createContext(selectedModel),
    );

    const secondSession = createHarness(store, "medium", [selectedModel]);
    await secondSession.handlers.get("session_start")?.(
        { reason: "new" },
        createContext(model("anthropic", "claude-sonnet"), [selectedModel]),
    );

    assert.deepEqual(secondSession.appliedModels, [selectedModel]);
});

test("直接启动的新会话已有初始化 entries 时仍恢复最后模型", async () => {
    const store = new MemoryStore();
    store.lastModel = model("zai-coding-cn", "glm-5.3");
    const session = createHarness(store, "medium", [store.lastModel]);
    const bootstrapEntries = [
        { type: "model_change" },
        { type: "thinking_level_change" },
        { type: "custom" },
    ];

    await session.handlers.get("session_start")?.(
        { reason: "startup" },
        createContext(model("openai-codex", "gpt-5.6-sol"), [store.lastModel], bootstrapEntries),
    );

    assert.deepEqual(session.appliedModels, [store.lastModel]);
});

test("恢复已有会话时不使用全局最后模型覆盖会话模型", async () => {
    const store = new MemoryStore();
    store.lastModel = model("openai", "gpt-5");
    const session = createHarness(store, "medium", [store.lastModel]);

    await session.handlers.get("session_start")?.(
        { reason: "resume" },
        createContext(model("anthropic", "claude-opus"), [store.lastModel]),
    );

    assert.deepEqual(session.appliedModels, []);
});

test("Pi 恢复会话产生的 model_select 不覆盖最后手动选择", async () => {
    const store = new MemoryStore();
    store.lastModel = model("openai", "gpt-5");
    const session = createHarness(store);

    await session.handlers.get("model_select")?.(
        {
            model: model("anthropic", "claude-opus"),
            previousModel: model("openai", "gpt-5"),
            source: "restore",
        },
        createContext(model("anthropic", "claude-opus")),
    );

    assert.deepEqual(store.lastModel, model("openai", "gpt-5"));
});

test("Fork 后恢复执行 Fork 前的当前模型", async () => {
    const store = new MemoryStore();
    const forkModel = model("zai-coding-cn", "glm-5.3");
    const extension = createModelThinkingMemoryExtension(store);
    const sourceSession = createHarness(store, "max", [forkModel], extension);

    await sourceSession.handlers.get("session_before_fork")?.(
        { entryId: "user-entry", position: "before" },
        createContext(forkModel, [forkModel]),
    );

    const forkedSession = createHarness(store, "medium", [forkModel], extension);
    await forkedSession.handlers.get("session_start")?.(
        { reason: "fork", previousSessionFile: "/sessions/source.jsonl" },
        createContext(model("openai-codex", "gpt-5.6-sol"), [forkModel]),
    );

    assert.deepEqual(forkedSession.appliedModels, [forkModel]);
});

test("JSON Store 在旧 thinking level 数据旁持久化最后模型", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-model-memory-"));
    const filePath = join(directory, "memory.json");
    writeFileSync(filePath, '{"anthropic/claude-opus":"high"}\n');

    try {
        const store = new JsonModelThinkingMemoryStore(filePath);
        const selectedModel = model("openai", "gpt-5");
        store.setLastModel(selectedModel);

        const reloadedStore = new JsonModelThinkingMemoryStore(filePath);
        assert.equal(reloadedStore.get("anthropic/claude-opus"), "high");
        assert.deepEqual(reloadedStore.getLastModel(), selectedModel);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

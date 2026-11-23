import assert from "node:assert/strict";
import test from "node:test";

const forkModel = await import("./fork-model.ts").catch(() => ({} as Record<string, unknown>));

test("Rewind Fork 在新 Session 启动时恢复 Fork 前的模型和 thinking level", async () => {
    assert.equal(typeof forkModel.withPreservedForkRuntime, "function", "应提供 withPreservedForkRuntime");
    assert.equal(typeof forkModel.restorePreservedForkRuntime, "function", "应提供 restorePreservedForkRuntime");
    const withPreserved = forkModel.withPreservedForkRuntime as (
        runtime: object,
        operation: () => Promise<void>,
    ) => Promise<void>;
    const restore = forkModel.restorePreservedForkRuntime as (
        previousSessionFile: string | undefined,
        actions: object,
    ) => Promise<boolean>;
    let activeModel = "default/default-model";
    let thinkingLevel = "off";

    await withPreserved({
        sourceSessionFile: "/sessions/source.jsonl",
        provider: "custom-provider",
        modelId: "selected-model",
        thinkingLevel: "high",
    }, async () => {
        const restored = await restore("/sessions/source.jsonl", {
            findModel: (provider: string, modelId: string) => ({ provider, id: modelId }),
            setModel: async (model: { provider: string; id: string }) => {
                activeModel = `${model.provider}/${model.id}`;
                return true;
            },
            setThinkingLevel: (level: string) => {
                thinkingLevel = level;
            },
        });
        assert.equal(restored, true);
    });

    assert.equal(activeModel, "custom-provider/selected-model");
    assert.equal(thinkingLevel, "high");
});

test("取消或失败的 Fork 不会把模型状态泄漏给后续普通 Fork", async () => {
    const withPreserved = forkModel.withPreservedForkRuntime as (
        runtime: object,
        operation: () => Promise<void>,
    ) => Promise<void>;
    const restore = forkModel.restorePreservedForkRuntime as (
        previousSessionFile: string | undefined,
        actions: object,
    ) => Promise<boolean>;

    await assert.rejects(
        withPreserved({
            sourceSessionFile: "/sessions/cancelled.jsonl",
            provider: "provider",
            modelId: "model",
            thinkingLevel: "medium",
        }, async () => {
            throw new Error("fork cancelled");
        }),
        /fork cancelled/,
    );

    const restored = await restore("/sessions/other.jsonl", {
        findModel: () => ({ provider: "provider", id: "model" }),
        setModel: async () => true,
        setThinkingLevel: () => {},
    });
    assert.equal(restored, false);
});

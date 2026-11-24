import assert from "node:assert/strict";
import { test } from "node:test";
import { Collaboration, type Request } from "../.pi/extensions/model-delegation/core.ts";

const request: Request = { model: "p/a", level: "high", access: "read", task: "分析" };
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

test("跨线程只读并发、写入独占且取消只影响自身", async () => {
    const entered: string[] = [];
    const release = deferred();
    const collaboration = new Collaboration(async () => ({
        async prompt(text, signal) {
            entered.push(text);
            await Promise.race([release.promise, new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => resolve(), { once: true });
            })]);
            return text;
        },
        dispose() {},
    }));
    const controller = new AbortController();
    const a = collaboration.run({ ...request, task: "a" }, controller.signal);
    const b = collaboration.run({ ...request, task: "b" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(entered, ["a", "b"]);
    await assert.rejects(collaboration.run({ ...request, access: "write" }), /独占/);
    controller.abort();
    await assert.rejects(a, /取消/);
    release.resolve();
    assert.equal((await b).text, "b");
    await collaboration.clear();
});

test("写入任务阻止读写任务，失败后释放占用", async () => {
    const release = deferred();
    const collaboration = new Collaboration(async () => ({
        async prompt() { await release.promise; throw new Error("模拟失败"); }, dispose() {},
    }));
    const writing = collaboration.run({ ...request, access: "write" });
    await assert.rejects(collaboration.run(request), /独占/);
    await assert.rejects(collaboration.run({ ...request, access: "write" }), /独占/);
    release.resolve();
    await assert.rejects(writing, /模拟失败/);
    await assert.rejects(collaboration.run(request), /模拟失败/);
    await collaboration.clear();
});

test("创建期间清理拒绝新任务并释放晚到的子会话", async () => {
    const release = deferred();
    let disposed = 0;
    const collaboration = new Collaboration(async () => {
        await release.promise;
        return { async prompt() { return "不应执行"; }, dispose() { disposed++; } };
    });
    const running = collaboration.run(request);
    const rejected = assert.rejects(running, /取消/);
    // 确保 create 已进入挂起点，而不是在启动前就取消。
    await new Promise<void>((resolve) => setImmediate(resolve));
    const clearing = collaboration.clear();
    await assert.rejects(collaboration.run(request), /清理/);
    release.resolve();
    await Promise.all([clearing, rejected]);
    assert.equal(disposed, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountStore, fingerprint } from "../.pi/extensions/multi-accounts/store.ts";
import { parseUsage, queryQuota, resetTime } from "../.pi/extensions/multi-accounts/quota.ts";

test("额度状态验证与多窗口恢复时间", () => {
    assert.equal(parseUsage({}), undefined);
    assert.equal(resetTime("123"), undefined);
    assert.deepEqual(parseUsage({ rate_limit: { allowed: true, limit_reached: false } }), { available: true, resetAt: undefined });
    assert.deepEqual(parseUsage({ rate_limit: { allowed: false, limit_reached: true,
        primary_window: { used_percent: 100, reset_at: 100 }, secondary_window: { used_percent: 100, reset_at: 200 } } }), { available: false, resetAt: 200000 });
    assert.equal(parseUsage({ rate_limit: { allowed: false, limit_reached: true,
        primary_window: { used_percent: 100 } } })?.resetAt, undefined);
});
test("额度查询使用固定官方地址且失败不判为可用", async () => {
    const credential = { type: "oauth" as const, access: "fake", refresh: "fake", expires: 1 };
    assert.equal(await queryQuota(credential, async (url, options) => {
        assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
        assert.equal(options?.redirect, "error");
        return new Response("", { status: 401 });
    }), undefined);
});
test("历史受限账号经探测恢复后可切换，未确认可用的候选被跳过", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quota-store-"));
    try {
        const store = new AccountStore(dir);
        const a = { type: "oauth" as const, access: "fake-a", refresh: "fake-ra", expires: 1 };
        const b = { ...a, access: "fake-b" };
        const first = await store.save("codex", a, "A", true);
        await store.save("codex", b, "B", true);
        await store.update("codex", pool => { pool.auto = true; pool.accounts[0].blockedModels = ["model"]; });
        let s = await store.snapshot("codex");
        assert.equal(await store.rotate("codex", fingerprint(b), s.pool.generation, "model", undefined,
            new Map([[first, { credential: "stale-credential", state: { available: true } }]])), false);
        assert.equal((await store.snapshot("codex")).current?.type, "oauth");
        s = await store.snapshot("codex");
        assert.equal(await store.rotate("codex", fingerprint(b), s.pool.generation, "model", 9999999999999, new Map()), false);
        s = await store.snapshot("codex");
        assert.equal(await store.rotate("codex", fingerprint(b), s.pool.generation, "model", 9999999999999,
            new Map([[first, { credential: fingerprint(a), state: { available: true } }]])), true);
        assert.equal((await store.snapshot("codex")).pool.active, first);
        assert.deepEqual((await store.snapshot("codex")).pool.accounts[0].blockedModels, []);
        await store.update("codex", pool => {
            pool.accounts[0].blockedModels = ["model"];
            pool.accounts[0].quotaResets = { model: Date.now() + 60000 };
        });
        assert.deepEqual((await store.snapshot("codex")).pool.accounts[0].blockedModels, ["model"]);
        await store.update("codex", pool => { pool.accounts[0].quotaResets = { model: Date.now() - 1 }; });
        assert.deepEqual((await store.snapshot("codex")).pool.accounts[0].blockedModels, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

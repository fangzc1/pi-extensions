import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, fingerprint, isCredential } from "../.pi/extensions/multi-accounts/store.ts";
const a = { type: "oauth" as const, access: "fake-a", refresh: "fake-ra", expires: 1 };
const b = { type: "oauth" as const, access: "fake-b", refresh: "fake-rb", expires: 2 };
async function fixture(run: (store: AccountStore) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "pi-accounts-"));
    try { await run(new AccountStore(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}
test("默认发现已有登录，切换保留其他 provider 并归档旧账号", () => fixture(async store => {
    await writeFile(store.authPath, JSON.stringify({ codex: a, other: { type: "api_key", key: "fake" } }));
    assert.deepEqual(await store.list(), ["codex", "other"]);
    assert.deepEqual((await store.snapshot("codex")).current, a);
    const id = await store.save("codex", b, "备用");
    assert.deepEqual((await store.snapshot("codex")).current, a);
    await store.use("codex", id);
    const auth = JSON.parse(await readFile(store.authPath, "utf8"));
    assert.deepEqual(auth.codex, b);
    assert.equal(auth.other.key, "fake");
    assert.equal((await store.snapshot("codex")).pool.accounts.length, 2);
}));
test("同一版本的耗尽只切换一次且普通管理不默认开启轮换", () => fixture(async store => {
    await store.save("codex", a, "A", true);
    await store.save("codex", b, "B");
    assert.equal((await store.snapshot("codex")).pool.auto, false);
    await store.update("codex", pool => { pool.auto = true; });
    const snapshot = await store.snapshot("codex");
    const results = await Promise.all([1, 2].map(() => store.rotate("codex", fingerprint(a), snapshot.pool.generation, "model")));
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual((await store.snapshot("codex")).current, b);
}));
test("切出时归档磁盘中的最新刷新结果而非旧备份", () => fixture(async store => {
    const token = (suffix: string) => `header.${Buffer.from(JSON.stringify({ sub: "user-a", "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a" }, suffix })).toString("base64url")}.signature`;
    const old = { ...a, access: token("old") };
    const fresh = { ...old, access: token("new"), refresh: "fake-rotated-refresh", expires: 9999 };
    await store.save("codex", old, "A", true);
    const id = await store.save("codex", b, "B");
    await writeFile(store.authPath, JSON.stringify({ codex: fresh }));
    await store.use("codex", id);
    const saved = (await store.snapshot("codex")).pool.accounts.find(account => account.label === "A");
    assert.deepEqual(saved?.credential, fresh);
}));
test("导入当前凭据保留用户指定名称", () => fixture(async store => {
    await writeFile(store.authPath, JSON.stringify({ codex: a }));
    const id = await store.save("codex", a, "我的账号");
    assert.equal((await store.snapshot("codex")).pool.accounts.find(item => item.id === id)?.label, "我的账号");
}));
test("仅保存同身份的新凭据不改写auth也不改动其字节内容", () => fixture(async store => {
    const token = (n: number) => `h.${Buffer.from(JSON.stringify({ sub: "same", "https://api.openai.com/auth": { chatgpt_account_id: "workspace" }, n })).toString("base64url")}.s`;
    const old = { ...a, access: token(1) };
    const fresh = { ...a, access: token(2), refresh: "fake-new" };
    await store.save("codex", old, "A", true);
    const before = await readFile(store.authPath, "utf8");
    const id = await store.save("codex", fresh, "新凭据", false);
    assert.equal(await readFile(store.authPath, "utf8"), before);
    await store.use("codex", id);
    assert.deepEqual(JSON.parse(await readFile(store.authPath, "utf8")).codex, fresh);
}));
test("确认框等待期间其他进程切号后拒绝发布旧登录结果", () => fixture(async store => {
    await store.save("codex", a, "A", true);
    const target = await store.save("codex", b, "B");
    const expected = fingerprint((await store.snapshot("codex")).current);
    const newer = { type: "api_key" as const, key: "fake-third" };
    await writeFile(store.authPath, JSON.stringify({ codex: newer }));
    await assert.rejects(store.use("codex", target, expected), /当前账号已变化/);
    assert.deepEqual(JSON.parse(await readFile(store.authPath, "utf8")).codex, newer);
}));
test("新路径兼容读取旧账号库，首次保存迁移并保留旧文件", () => fixture(async store => {
    const legacyDirectory = join(store.agentDir, "provider-accounts");
    const legacyPath = join(legacyDirectory, "accounts.json");
    await mkdir(legacyDirectory);
    const old = { version: 1, providers: { codex: { accounts: [{ id: "old-account", label: "旧账号", credential: a, enabled: true, blockedModels: [] }], generation: 0, auto: false } } };
    await writeFile(legacyPath, JSON.stringify(old));
    assert.equal(store.databasePath, join(store.agentDir, "multi-accounts", "accounts.json"));
    assert.equal((await store.snapshot("codex")).pool.accounts[0].label, "旧账号");
    await store.save("codex", b, "新账号");
    const saved = JSON.parse(await readFile(store.databasePath, "utf8"));
    assert.equal(saved.providers.codex.accounts.length, 2);
    assert.equal(await readFile(legacyPath, "utf8"), JSON.stringify(old));
}));
test("新账号库损坏不回退旧副本，也不覆盖任一文件", () => fixture(async store => {
    await mkdir(join(store.agentDir, "provider-accounts"));
    const legacy = join(store.agentDir, "provider-accounts", "accounts.json");
    await writeFile(legacy, JSON.stringify({ version: 1, providers: {} }));
    await mkdir(join(store.agentDir, "multi-accounts"));
    const target = join(store.agentDir, "multi-accounts", "accounts.json");
    await writeFile(target, "broken");
    await assert.rejects(store.save("codex", b, "B"));
    assert.equal(await readFile(target, "utf8"), "broken");
    assert.equal(await readFile(legacy, "utf8"), JSON.stringify({ version: 1, providers: {} }));
}));
test("API Key校验与宿主保持一致", () => {
    assert.equal(isCredential({ type: "api_key", key: 123, env: {} }), false);
    assert.equal(isCredential({ type: "api_key", key: "fake", env: { REGION: 12 } }), false);
    assert.equal(isCredential({ type: "api_key" }), true);
});
test("损坏账号库拒绝写入且不清空原始凭据", () => fixture(async store => {
    await store.save("codex", a, "A", true);
    await writeFile(store.databasePath, "broken");
    await assert.rejects(store.save("codex", b, "B"));
    assert.deepEqual(JSON.parse(await readFile(store.authPath, "utf8")).codex, a);
}));

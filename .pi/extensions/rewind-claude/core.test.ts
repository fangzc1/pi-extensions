import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const core = await import("./core.ts").catch(() => ({} as Record<string, unknown>));

test("双击 Esc：空草稿打开回退菜单，非空草稿保存并清空", () => {
    assert.equal(typeof core.DoubleEscapeDetector, "function", "应提供 DoubleEscapeDetector");
    const Detector = core.DoubleEscapeDetector as new (windowMs: number) => {
        press(now: number, text: string, idle: boolean): string;
    };

    const empty = new Detector(500);
    assert.equal(empty.press(1000, "", true), "armed");
    assert.equal(empty.press(1300, "", true), "open-rewind");

    const draft = new Detector(500);
    assert.equal(draft.press(2000, "修复测试", true), "armed");
    assert.equal(draft.press(2200, "修复测试", true), "save-draft");

    const running = new Detector(500);
    assert.equal(running.press(3000, "", false), "passthrough");
});

test("检查点：同一 Prompt 的同一路径只保存一次前置内容", async () => {
    assert.equal(typeof core.CheckpointStore, "function", "应提供 CheckpointStore");
    const root = await mkdtemp(join(tmpdir(), "rewind-store-"));
    const cwd = join(root, "project");
    const state = join(root, "state");
    await mkdir(cwd);
    const file = join(cwd, "demo.txt");
    await writeFile(file, "before", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const store = new Store({ rootDir: state, cwd, sessionId: "session-1", maxCheckpoints: 100 });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "修改 demo");
        await store.captureBefore(checkpoint.id, file);
        await writeFile(file, "after-first", "utf8");
        await store.captureBefore(checkpoint.id, file);

        const loaded = await store.getCheckpoint(checkpoint.id);
        assert.equal(Object.keys(loaded.snapshots).length, 1);
        const blob = await readFile(join(state, "blobs", loaded.snapshots["demo.txt"].blobSha256), "utf8");
        assert.equal(blob, "before");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("检查点：用户 entry 延迟落盘后可补绑定真实 ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-bind-"));
    const cwd = join(root, "project");
    await mkdir(cwd);
    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const store = new Store({ rootDir: join(root, "state"), cwd, sessionId: "session-bind" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("pending:123", "hello");
        await store.bindUserEntry(checkpoint.id, "real-user-entry");
        assert.equal((await store.getCheckpoint(checkpoint.id)).userEntryId, "real-user-entry");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("检查点：仅保留最近 100 个", async () => {
    assert.equal(typeof core.CheckpointStore, "function", "应提供 CheckpointStore");
    const root = await mkdtemp(join(tmpdir(), "rewind-retention-"));
    const cwd = join(root, "project");
    await mkdir(cwd);

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const store = new Store({ rootDir: join(root, "state"), cwd, sessionId: "session-2", maxCheckpoints: 100 });
        await store.initialize();
        for (let index = 0; index < 101; index++) {
            await store.createCheckpoint(`user-${index}`, `prompt-${index}`);
        }
        const checkpoints = await store.listCheckpoints();
        assert.equal(checkpoints.length, 100);
        assert.equal(checkpoints[0].userEntryId, "user-1");
        assert.equal(checkpoints[99].userEntryId, "user-100");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("检查点：淘汰旧检查点时清理无引用 Blob", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-gc-"));
    const cwd = join(root, "project");
    const state = join(root, "state");
    await mkdir(cwd);
    const file = join(cwd, "demo.txt");
    await writeFile(file, "orphaned", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const store = new Store({ rootDir: state, cwd, sessionId: "session-gc", maxCheckpoints: 2 });
        await store.initialize();
        const old = await store.createCheckpoint("user-0", "old");
        await store.captureBefore(old.id, file);
        assert.equal((await readdir(join(state, "blobs"))).length, 1);
        await store.createCheckpoint("user-1", "one");
        await store.createCheckpoint("user-2", "two");
        assert.equal((await readdir(join(state, "blobs"))).length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("检查点：超过 30 天后清理 Session 伴随快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-expiry-"));
    const cwd = join(root, "project");
    const state = join(root, "state");
    await mkdir(cwd);
    const file = join(cwd, "demo.txt");
    await writeFile(file, "old", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const oldStore = new Store({
            rootDir: state,
            cwd,
            sessionId: "session-expiry",
            now: () => new Date("2026-01-01T00:00:00.000Z"),
        });
        await oldStore.initialize();
        const checkpoint = await oldStore.createCheckpoint("user-old", "old");
        await oldStore.captureBefore(checkpoint.id, file);

        const resumed = new Store({
            rootDir: state,
            cwd,
            sessionId: "session-expiry",
            now: () => new Date("2026-02-01T00:00:01.000Z"),
        });
        await resumed.initialize();
        assert.equal((await resumed.listCheckpoints()).length, 0);
        assert.equal((await readdir(join(state, "blobs"))).length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Fork：新 Manifest 仅继承祖先 checkpoint，并通过硬链接共享不可变 blob", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-fork-"));
    const cwd = join(root, "project");
    const sourceRoot = join(root, "source-state");
    const forkRoot = join(root, "fork-state");
    await mkdir(cwd);
    const file = join(cwd, "hello.html");
    await writeFile(file, "hello world\n", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const source = new Store({ rootDir: sourceRoot, cwd, sessionId: "source-session" });
        await source.initialize();
        const ancestor = await source.createCheckpoint("user-1", "第一次");
        await source.captureBefore(ancestor.id, file);
        await writeFile(file, "hello\n", "utf8");
        const abandoned = await source.createCheckpoint("user-2", "第二次");
        await source.captureBefore(abandoned.id, file);

        const fork = new Store({ rootDir: forkRoot, cwd, sessionId: "fork-session" });
        await fork.initialize();
        assert.equal(typeof fork.inheritFork, "function", "应提供 inheritFork");
        await fork.inheritFork(sourceRoot, new Set(["user-1"]));

        assert.deepEqual((await fork.listCheckpoints()).map((item: any) => item.userEntryId), ["user-1"]);
        const inherited = await fork.getCheckpoint(ancestor.id);
        const sha = inherited.snapshots["hello.html"].blobSha256;
        const sourceBlob = join(sourceRoot, "blobs", sha);
        const forkBlob = join(forkRoot, "blobs", sha);
        assert.equal((await stat(sourceBlob)).ino, (await stat(forkBlob)).ino);

        await rm(sourceRoot, { recursive: true, force: true });
        assert.equal((await fork.readBlob(sha)).toString("utf8"), "hello world\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("项目外文件：绝对路径可建立检查点、预览并恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-external-"));
    const cwd = join(root, "project");
    const state = join(root, "state");
    const externalFile = join(root, "outside.txt");
    await mkdir(cwd);
    await writeFile(externalFile, "before\n", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const Restorer = core.FileRestorer as new (store: any) => any;
        const store = new Store({ rootDir: state, cwd, sessionId: "session-external" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "修改项目外文件");
        await store.captureBefore(checkpoint.id, externalFile);
        await writeFile(externalFile, "after\n", "utf8");

        assert.deepEqual(await store.previewRestore(checkpoint.id), [
            { path: externalFile, additions: 1, deletions: 1 },
        ]);
        const result = await new Restorer(store).restore(checkpoint.id);
        assert.equal(result.restored, 1);
        assert.equal(await readFile(externalFile, "utf8"), "before\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("恢复：回退目标后的首次快照决定目标内容，并删除新建文件", async () => {
    assert.equal(typeof core.CheckpointStore, "function", "应提供 CheckpointStore");
    assert.equal(typeof core.FileRestorer, "function", "应提供 FileRestorer");
    const root = await mkdtemp(join(tmpdir(), "rewind-restore-"));
    const cwd = join(root, "project");
    const state = join(root, "state");
    await mkdir(cwd);
    const changed = join(cwd, "changed.txt");
    const created = join(cwd, "created.txt");
    await writeFile(changed, "v1", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const Restorer = core.FileRestorer as new (store: any) => any;
        const store = new Store({ rootDir: state, cwd, sessionId: "session-3", maxCheckpoints: 100 });
        await store.initialize();
        const first = await store.createCheckpoint("user-1", "第一次");
        await store.captureBefore(first.id, changed);
        await store.captureBefore(first.id, created);
        await writeFile(changed, "v2", "utf8");
        await writeFile(created, "new", "utf8");

        const second = await store.createCheckpoint("user-2", "第二次");
        await store.captureBefore(second.id, changed);
        await writeFile(changed, "v3", "utf8");

        const result = await new Restorer(store).restore(first.id);
        assert.equal(await readFile(changed, "utf8"), "v1");
        await assert.rejects(readFile(created, "utf8"), /ENOENT/);
        assert.equal(result.restored, 2);
        assert.equal(result.skipped, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Turn 统计：按工具执行前后内容记录正向新增与删除", async () => {
    assert.equal(typeof core.ToolChangeTracker, "function", "应提供 ToolChangeTracker");
    const root = await mkdtemp(join(tmpdir(), "rewind-turn-stats-"));
    const cwd = join(root, "project");
    await mkdir(cwd);
    const file = join(cwd, "hello.txt");
    await writeFile(file, "hello world\n", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const Tracker = core.ToolChangeTracker as new (store: any) => any;
        const store = new Store({ rootDir: join(root, "state"), cwd, sessionId: "session-turn" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "修改内容");
        const tracker = new Tracker(store);

        await tracker.begin("tool-1", checkpoint.id, file);
        await writeFile(file, "hello\nnew line\n", "utf8");
        await tracker.complete("tool-1", false);

        assert.deepEqual(await store.listTurnChanges(checkpoint.id), [
            { path: "hello.txt", additions: 2, deletions: 1 },
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Turn 统计：同一路径多次成功编辑累加，失败工具不计入", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-turn-aggregate-"));
    const cwd = join(root, "project");
    await mkdir(cwd);
    const file = join(cwd, "demo.txt");
    await writeFile(file, "a\n", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const Tracker = core.ToolChangeTracker as new (store: any) => any;
        const store = new Store({ rootDir: join(root, "state"), cwd, sessionId: "session-aggregate" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "连续修改");
        const tracker = new Tracker(store);

        await tracker.begin("tool-1", checkpoint.id, file);
        await writeFile(file, "a\nb\n", "utf8");
        await tracker.complete("tool-1", false);
        await tracker.begin("tool-2", checkpoint.id, file);
        await writeFile(file, "a\nb\nc\n", "utf8");
        await tracker.complete("tool-2", false);
        await tracker.begin("tool-failed", checkpoint.id, file);
        await writeFile(file, "should-not-count\n", "utf8");
        await tracker.complete("tool-failed", true);

        assert.deepEqual(await store.listTurnChanges(checkpoint.id), [
            { path: "demo.txt", additions: 2, deletions: 0 },
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Turn 统计：旧 Manifest 没有 changes 字段时标记为不可用", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-turn-legacy-"));
    const cwd = join(root, "project");
    const state = join(root, "state");
    await mkdir(cwd);

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const store = new Store({ rootDir: state, cwd, sessionId: "session-legacy" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "旧检查点");
        const manifestPath = join(state, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        delete manifest.checkpoints[0].changes;
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

        const resumed = new Store({ rootDir: state, cwd, sessionId: "session-legacy" });
        await resumed.initialize();
        assert.equal(await resumed.listTurnChanges(checkpoint.id), undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("恢复预览：按文件统计 Claude Code 风格的新增与删除行数", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-preview-"));
    const cwd = join(root, "project");
    const state = join(root, "state");
    await mkdir(cwd);
    const file = join(cwd, "hello.html");
    await writeFile(file, "hello world\n", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const store = new Store({ rootDir: state, cwd, sessionId: "session-preview" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "改为 hello");
        await store.captureBefore(checkpoint.id, file);
        await writeFile(file, "hello\n", "utf8");

        assert.equal(typeof store.previewRestore, "function", "应提供 previewRestore");
        assert.deepEqual(await store.previewRestore(checkpoint.id), [
            { path: "hello.html", additions: 1, deletions: 1 },
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("恢复：任一 Blob 预检失败时不产生部分恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-atomic-"));
    const cwd = join(root, "project");
    const state = join(root, "state");
    await mkdir(cwd);
    const firstFile = join(cwd, "a.txt");
    const secondFile = join(cwd, "b.txt");
    await writeFile(firstFile, "a-before", "utf8");
    await writeFile(secondFile, "b-before", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const Restorer = core.FileRestorer as new (store: any) => any;
        const store = new Store({ rootDir: state, cwd, sessionId: "session-atomic" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "atomic");
        await store.captureBefore(checkpoint.id, firstFile);
        await store.captureBefore(checkpoint.id, secondFile);
        await writeFile(firstFile, "a-after", "utf8");
        await writeFile(secondFile, "b-after", "utf8");
        const loaded = await store.getCheckpoint(checkpoint.id);
        await rm(join(state, "blobs", loaded.snapshots["b.txt"].blobSha256), { force: true });

        const result = await new Restorer(store).restore(checkpoint.id);
        assert.equal(result.failed, 1);
        assert.equal(result.restored, 0);
        assert.equal(await readFile(firstFile, "utf8"), "a-after");
        assert.equal(await readFile(secondFile, "utf8"), "b-after");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("路径安全：拒绝通过父目录符号链接捕获 cwd 外文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-parent-link-"));
    const cwd = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");
    await symlink(outside, join(cwd, "linked-dir"));

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const store = new Store({ rootDir: join(root, "state"), cwd, sessionId: "session-parent-link" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "越界路径");

        await assert.rejects(
            store.captureBefore(checkpoint.id, "linked-dir/secret.txt"),
            /outside cwd/,
        );
        assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("路径安全：恢复前父目录变为 cwd 外符号链接时跳过恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-restore-parent-link-"));
    const cwd = join(root, "project");
    const outside = join(root, "outside");
    const trackedDir = join(cwd, "tracked");
    await mkdir(cwd);
    await mkdir(outside);
    await mkdir(trackedDir);
    await writeFile(join(trackedDir, "demo.txt"), "before", "utf8");
    await writeFile(join(outside, "demo.txt"), "outside", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const Restorer = core.FileRestorer as new (store: any) => any;
        const store = new Store({ rootDir: join(root, "state"), cwd, sessionId: "session-restore-parent-link" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "恢复越界路径");
        await store.captureBefore(checkpoint.id, "tracked/demo.txt");
        await rm(trackedDir, { recursive: true });
        await symlink(outside, trackedDir);

        const result = await new Restorer(store).restore(checkpoint.id);
        assert.equal(result.failed, 0);
        assert.equal(result.restored, 0);
        assert.equal(result.skipped, 1);
        assert.deepEqual(result.skippedPaths, ["tracked/demo.txt"]);
        assert.equal(await readFile(join(outside, "demo.txt"), "utf8"), "outside");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("路径安全：父目录符号链接改指 cwd 内另一位置时跳过恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-parent-retarget-"));
    const cwd = join(root, "project");
    const firstDir = join(cwd, "first");
    const secondDir = join(cwd, "second");
    const linkedDir = join(cwd, "linked");
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir);
    await writeFile(join(firstDir, "demo.txt"), "before", "utf8");
    await writeFile(join(secondDir, "demo.txt"), "unrelated", "utf8");
    await symlink(firstDir, linkedDir);

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const Restorer = core.FileRestorer as new (store: any) => any;
        const store = new Store({ rootDir: join(root, "state"), cwd, sessionId: "session-parent-retarget" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "父目录改指");
        await store.captureBefore(checkpoint.id, "linked/demo.txt");
        await writeFile(join(firstDir, "demo.txt"), "after", "utf8");
        await rm(linkedDir);
        await symlink(secondDir, linkedDir);

        const result = await new Restorer(store).restore(checkpoint.id);
        assert.equal(result.failed, 0);
        assert.equal(result.restored, 0);
        assert.equal(result.skipped, 1);
        assert.equal(await readFile(join(firstDir, "demo.txt"), "utf8"), "after");
        assert.equal(await readFile(join(secondDir, "demo.txt"), "utf8"), "unrelated");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("恢复：Blob 内容与 SHA-256 不一致时拒绝恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "rewind-corrupt-blob-"));
    const cwd = join(root, "project");
    const state = join(root, "state");
    await mkdir(cwd);
    const file = join(cwd, "demo.txt");
    await writeFile(file, "before", "utf8");

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const Restorer = core.FileRestorer as new (store: any) => any;
        const store = new Store({ rootDir: state, cwd, sessionId: "session-corrupt" });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "完整性校验");
        await store.captureBefore(checkpoint.id, file);
        const loaded = await store.getCheckpoint(checkpoint.id);
        await writeFile(join(state, "blobs", loaded.snapshots["demo.txt"].blobSha256), "corrupted", "utf8");
        await writeFile(file, "after", "utf8");

        const result = await new Restorer(store).restore(checkpoint.id);
        assert.equal(result.failed, 1);
        assert.equal(result.restored, 0);
        assert.equal(await readFile(file, "utf8"), "after");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("恢复：符号链接必须跳过", async () => {
    assert.equal(typeof core.CheckpointStore, "function", "应提供 CheckpointStore");
    assert.equal(typeof core.FileRestorer, "function", "应提供 FileRestorer");
    const root = await mkdtemp(join(tmpdir(), "rewind-link-"));
    const cwd = join(root, "project");
    await mkdir(cwd);
    const outside = join(root, "outside.txt");
    const link = join(cwd, "link.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, link);

    try {
        const Store = core.CheckpointStore as new (options: object) => any;
        const Restorer = core.FileRestorer as new (store: any) => any;
        const store = new Store({ rootDir: join(root, "state"), cwd, sessionId: "session-4", maxCheckpoints: 100 });
        await store.initialize();
        const checkpoint = await store.createCheckpoint("user-1", "链接");
        await store.captureBefore(checkpoint.id, link);
        const result = await new Restorer(store).restore(checkpoint.id);
        assert.equal(result.restored, 0);
        assert.equal(result.skipped, 1);
        assert.equal(await readFile(outside, "utf8"), "outside");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

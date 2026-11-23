import { createHash, randomUUID } from "node:crypto";
import {
    chmod,
    link,
    lstat,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";

export type DoubleEscapeAction = "armed" | "open-rewind" | "save-draft" | "passthrough";

/** 只负责识别双击 Esc，不持有 Editor 或 Pi 运行时对象。 */
export class DoubleEscapeDetector {
    private lastEscapeAt: number | undefined;
    private readonly windowMs: number;

    constructor(windowMs = 500) {
        this.windowMs = windowMs;
    }

    press(now: number, text: string, idle: boolean): DoubleEscapeAction {
        if (!idle) {
            this.lastEscapeAt = undefined;
            return "passthrough";
        }
        if (this.lastEscapeAt === undefined || now - this.lastEscapeAt > this.windowMs) {
            this.lastEscapeAt = now;
            return "armed";
        }
        this.lastEscapeAt = undefined;
        return text.length > 0 ? "save-draft" : "open-rewind";
    }

    reset(): void {
        this.lastEscapeAt = undefined;
    }
}

export interface SnapshotRef {
    existed: boolean;
    blobSha256?: string;
    mode?: number;
    size?: number;
    unsupported?: "symlink" | "hardlink" | "non-file";
    /** 捕获时父目录解析到的真实位置，用于防止恢复写入后来改指的目录。 */
    parentRealPath?: string;
}

export interface Checkpoint {
    id: string;
    userEntryId: string;
    promptPreview: string;
    createdAt: string;
    snapshots: Record<string, SnapshotRef>;
    /** 当前 Prompt 后由 edit/write 工具产生的正向变更统计。 */
    changes?: RestoreChange[];
}

interface RewindManifest {
    version: 1;
    sessionId: string;
    cwd: string;
    updatedAt: string;
    checkpoints: Checkpoint[];
}

interface CheckpointStoreOptions {
    rootDir: string;
    cwd: string;
    sessionId: string;
    maxCheckpoints?: number;
    now?: () => Date;
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function promptPreview(prompt: string): string {
    return prompt.replace(/\s+/g, " ").trim().slice(0, 160) || "(empty prompt)";
}

/** 持久化 Session 伴随检查点；所有 Manifest 变更均在同一串行队列内执行。 */
export class CheckpointStore {
    readonly rootDir: string;
    readonly cwd: string;
    private readonly sessionId: string;
    private readonly maxCheckpoints: number;
    private readonly manifestPath: string;
    private readonly blobDir: string;
    private readonly now: () => Date;
    private manifest!: RewindManifest;
    private cwdRealPath!: string;
    private mutationQueue: Promise<void> = Promise.resolve();

    constructor(options: CheckpointStoreOptions) {
        this.rootDir = resolve(options.rootDir);
        this.cwd = resolve(options.cwd);
        this.sessionId = options.sessionId;
        this.maxCheckpoints = options.maxCheckpoints ?? 100;
        this.now = options.now ?? (() => new Date());
        this.manifestPath = resolve(this.rootDir, "manifest.json");
        this.blobDir = resolve(this.rootDir, "blobs");
    }

    async initialize(): Promise<void> {
        this.cwdRealPath = await realpath(this.cwd);
        await mkdir(this.blobDir, { recursive: true, mode: 0o700 });
        try {
            const parsed = JSON.parse(await readFile(this.manifestPath, "utf8")) as RewindManifest;
            if (parsed.version !== 1 || parsed.sessionId !== this.sessionId || resolve(parsed.cwd) !== this.cwd) {
                throw new Error("Rewind manifest does not match the current session");
            }
            this.manifest = parsed;
            const ageMs = this.now().getTime() - new Date(parsed.updatedAt).getTime();
            if (ageMs > 30 * 24 * 60 * 60 * 1000) {
                this.manifest.checkpoints = [];
                await this.persist();
                await this.collectUnreferencedBlobs();
            }
        } catch (error) {
            if (!isMissing(error)) throw error;
            this.manifest = {
                version: 1,
                sessionId: this.sessionId,
                cwd: this.cwd,
                updatedAt: this.now().toISOString(),
                checkpoints: [],
            };
            await this.persist();
        }
    }

    async inheritFork(sourceRootDir: string, activeUserEntryIds: ReadonlySet<string>): Promise<void> {
        await this.mutate(async () => {
            // Fork runtime 可能被重复加载；已有新分支数据时不得再次覆盖。
            if (this.manifest.checkpoints.length > 0) return;
            const sourceRoot = resolve(sourceRootDir);
            let source: RewindManifest;
            try {
                source = JSON.parse(await readFile(resolve(sourceRoot, "manifest.json"), "utf8")) as RewindManifest;
            } catch (error) {
                if (isMissing(error)) return;
                throw error;
            }
            if (source.version !== 1 || resolve(source.cwd) !== this.cwd) {
                throw new Error("Fork source manifest does not match the current project");
            }

            const checkpoints = source.checkpoints.filter((checkpoint) =>
                activeUserEntryIds.has(checkpoint.userEntryId),
            );
            const hashes = new Set<string>();
            for (const checkpoint of checkpoints) {
                for (const snapshot of Object.values(checkpoint.snapshots)) {
                    if (!snapshot.blobSha256) continue;
                    if (!/^[a-f0-9]{64}$/u.test(snapshot.blobSha256)) {
                        throw new Error("Fork source manifest contains an invalid blob hash");
                    }
                    hashes.add(snapshot.blobSha256);
                }
            }

            const created: string[] = [];
            try {
                for (const hash of hashes) {
                    const destination = resolve(this.blobDir, hash);
                    try {
                        await link(resolve(sourceRoot, "blobs", hash), destination);
                        created.push(destination);
                    } catch (error) {
                        const code = (error as NodeJS.ErrnoException).code;
                        if (code === "EEXIST") continue;
                        if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") throw error;
                        try {
                            await writeFile(destination, await readFile(resolve(sourceRoot, "blobs", hash)), {
                                flag: "wx",
                                mode: 0o600,
                            });
                            created.push(destination);
                        } catch (copyError) {
                            if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") throw copyError;
                        }
                    }
                }
                this.manifest.checkpoints = structuredClone(checkpoints);
                await this.persist();
            } catch (error) {
                for (const path of created) await rm(path, { force: true });
                throw error;
            }
        });
    }

    async createCheckpoint(userEntryId: string, prompt: string): Promise<Checkpoint> {
        return this.mutate(async () => {
            const checkpoint: Checkpoint = {
                id: randomUUID(),
                userEntryId,
                promptPreview: promptPreview(prompt),
                createdAt: this.now().toISOString(),
                snapshots: {},
                changes: [],
            };
            this.manifest.checkpoints.push(checkpoint);
            if (this.manifest.checkpoints.length > this.maxCheckpoints) {
                this.manifest.checkpoints.splice(0, this.manifest.checkpoints.length - this.maxCheckpoints);
            }
            await this.persist();
            await this.collectUnreferencedBlobs();
            return structuredClone(checkpoint);
        });
    }

    async bindUserEntry(checkpointId: string, userEntryId: string): Promise<void> {
        await this.mutate(async () => {
            const checkpoint = this.requireCheckpoint(checkpointId);
            checkpoint.userEntryId = userEntryId;
            await this.persist();
        });
    }

    async captureBefore(checkpointId: string, filePath: string): Promise<void> {
        await this.mutate(async () => {
            const checkpoint = this.requireCheckpoint(checkpointId);
            const trackedPath = this.toTrackedPath(filePath);
            if (checkpoint.snapshots[trackedPath]) return;

            checkpoint.snapshots[trackedPath] = await this.createSnapshot(
                await this.resolveTrackedPath(trackedPath),
            );
            await this.persist();
        });
    }

    async getCheckpoint(checkpointId: string): Promise<Checkpoint> {
        await this.mutationQueue;
        return structuredClone(this.requireCheckpoint(checkpointId));
    }

    async listTurnChanges(checkpointId: string): Promise<RestoreChange[] | undefined> {
        await this.mutationQueue;
        const changes = this.requireCheckpoint(checkpointId).changes;
        return changes === undefined ? undefined : structuredClone(changes);
    }

    async recordTurnChange(checkpointId: string, change: RestoreChange): Promise<void> {
        await this.mutate(async () => {
            const checkpoint = this.requireCheckpoint(checkpointId);
            const changes = checkpoint.changes ??= [];
            const existing = changes.find((item) => item.path === change.path);
            if (existing) {
                existing.additions += change.additions;
                existing.deletions += change.deletions;
            } else {
                changes.push(structuredClone(change));
            }
            await this.persist();
        });
    }

    async inspectWorkingFile(filePath: string): Promise<{
        path: string;
        existed: boolean;
        content: string;
    } | undefined> {
        const path = this.toTrackedPath(filePath);
        const absolutePath = await this.resolveTrackedPath(path);
        try {
            const stat = await lstat(absolutePath);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) return undefined;
            return { path, existed: true, content: await readFile(absolutePath, "utf8") };
        } catch (error) {
            if (isMissing(error)) return { path, existed: false, content: "" };
            throw error;
        }
    }

    async listCheckpoints(): Promise<Checkpoint[]> {
        await this.mutationQueue;
        return structuredClone(this.manifest.checkpoints);
    }

    async buildRestorePlan(checkpointId: string): Promise<Map<string, SnapshotRef>> {
        await this.mutationQueue;
        const index = this.manifest.checkpoints.findIndex((item) => item.id === checkpointId);
        if (index < 0) throw new Error(`Unknown rewind checkpoint: ${checkpointId}`);
        const plan = new Map<string, SnapshotRef>();
        for (const checkpoint of this.manifest.checkpoints.slice(index)) {
            for (const [path, snapshot] of Object.entries(checkpoint.snapshots)) {
                if (!plan.has(path)) plan.set(path, structuredClone(snapshot));
            }
        }
        return plan;
    }

    async hasRestorableChanges(checkpointId: string): Promise<boolean> {
        return (await this.buildRestorePlan(checkpointId)).size > 0;
    }

    async previewRestore(checkpointId: string): Promise<RestoreChange[]> {
        const plan = await this.buildRestorePlan(checkpointId);
        const changes: RestoreChange[] = [];
        for (const [path, snapshot] of plan) {
            if (snapshot.unsupported) continue;
            const absolutePath = await this.resolveRestorePath(path, snapshot.parentRealPath);
            if (!absolutePath) continue;
            const before = snapshot.existed && snapshot.blobSha256
                ? (await this.readBlob(snapshot.blobSha256)).toString("utf8")
                : "";
            let current = "";
            try {
                current = await readFile(absolutePath, "utf8");
            } catch (error) {
                if (!isMissing(error)) throw error;
            }
            if (before === current) continue;
            const patch = generateUnifiedPatch(path, current, before);
            const additions = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
            const deletions = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
            changes.push({ path, additions, deletions });
        }
        return changes;
    }

    async readBlob(sha256: string): Promise<Buffer> {
        if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`Invalid rewind blob hash: ${sha256}`);
        const content = await readFile(resolve(this.blobDir, sha256));
        const actualSha256 = createHash("sha256").update(content).digest("hex");
        if (actualSha256 !== sha256) throw new Error(`Rewind blob integrity check failed: ${sha256}`);
        return content;
    }

    async resolveTrackedPath(trackedPath: string): Promise<string> {
        if (isAbsolute(trackedPath)) return resolve(trackedPath);
        const absolutePath = this.resolveSafeRelative(trackedPath);
        await this.assertParentWithinCwd(absolutePath);
        return absolutePath;
    }

    async resolveRestorePath(trackedPath: string, expectedParentRealPath?: string): Promise<string | undefined> {
        const absolutePath = isAbsolute(trackedPath)
            ? resolve(trackedPath)
            : this.resolveSafeRelative(trackedPath);
        if (expectedParentRealPath !== undefined) {
            try {
                const currentParentRealPath = await realpath(dirname(absolutePath));
                return currentParentRealPath === expectedParentRealPath ? absolutePath : undefined;
            } catch (error) {
                if (isMissing(error)) return undefined;
                throw error;
            }
        }
        // 旧 Manifest 没有父目录身份，只能继续沿用 cwd 越界保护。
        if (!isAbsolute(trackedPath)) await this.assertParentWithinCwd(absolutePath);
        return absolutePath;
    }

    private async createSnapshot(absolutePath: string): Promise<SnapshotRef> {
        let parentRealPath: string | undefined;
        try {
            parentRealPath = await realpath(dirname(absolutePath));
        } catch (error) {
            if (!isMissing(error)) throw error;
        }

        let stat;
        try {
            stat = await lstat(absolutePath);
        } catch (error) {
            if (isMissing(error)) return { existed: false, parentRealPath };
            throw error;
        }
        if (stat.isSymbolicLink()) return { existed: true, unsupported: "symlink", parentRealPath };
        if (!stat.isFile()) return { existed: true, unsupported: "non-file", parentRealPath };
        if (stat.nlink > 1) return { existed: true, unsupported: "hardlink", parentRealPath };

        const content = await readFile(absolutePath);
        const blobSha256 = createHash("sha256").update(content).digest("hex");
        const blobPath = resolve(this.blobDir, blobSha256);
        try {
            await writeFile(blobPath, content, { flag: "wx", mode: 0o600 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        }
        return { existed: true, blobSha256, mode: stat.mode, size: stat.size, parentRealPath };
    }

    private toTrackedPath(filePath: string): string {
        const absolutePath = resolve(this.cwd, filePath);
        const relativePath = relative(this.cwd, absolutePath);
        if (!relativePath || relativePath === ".") throw new Error("Cannot checkpoint the project root");
        if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
            // 项目外文件保留绝对路径，确保快照、预览和恢复指向同一位置。
            return absolutePath;
        }
        return relativePath.split(sep).join("/");
    }

    private resolveSafeRelative(relativePath: string): string {
        if (isAbsolute(relativePath)) throw new Error(`Unsafe absolute checkpoint path: ${relativePath}`);
        const absolutePath = resolve(this.cwd, relativePath);
        const back = relative(this.cwd, absolutePath);
        if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
            throw new Error(`Unsafe checkpoint path: ${relativePath}`);
        }
        return absolutePath;
    }

    private async assertParentWithinCwd(absolutePath: string): Promise<void> {
        let candidate = dirname(absolutePath);
        while (true) {
            try {
                const parentRealPath = await realpath(candidate);
                const back = relative(this.cwdRealPath, parentRealPath);
                if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
                    throw new Error(`Refusing to access path outside cwd: ${absolutePath}`);
                }
                return;
            } catch (error) {
                if (!isMissing(error)) throw error;
                const parent = dirname(candidate);
                if (parent === candidate) throw error;
                candidate = parent;
            }
        }
    }

    private requireCheckpoint(checkpointId: string): Checkpoint {
        const checkpoint = this.manifest.checkpoints.find((item) => item.id === checkpointId);
        if (!checkpoint) throw new Error(`Unknown rewind checkpoint: ${checkpointId}`);
        return checkpoint;
    }

    private async persist(): Promise<void> {
        this.manifest.updatedAt = this.now().toISOString();
        const tempPath = `${this.manifestPath}.${process.pid}.${randomUUID()}.tmp`;
        await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
        await writeFile(tempPath, `${JSON.stringify(this.manifest, null, 2)}\n`, { mode: 0o600 });
        await rename(tempPath, this.manifestPath);
    }

    private async collectUnreferencedBlobs(): Promise<void> {
        const referenced = new Set<string>();
        for (const checkpoint of this.manifest.checkpoints) {
            for (const snapshot of Object.values(checkpoint.snapshots)) {
                if (snapshot.blobSha256) referenced.add(snapshot.blobSha256);
            }
        }
        for (const fileName of await readdir(this.blobDir)) {
            if (!referenced.has(fileName)) {
                await rm(resolve(this.blobDir, fileName), { force: true });
            }
        }
    }

    private mutate<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation, operation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}

export interface RestoreChange {
    path: string;
    additions: number;
    deletions: number;
}

export interface RestoreResult {
    restored: number;
    skipped: number;
    failed: number;
    skippedPaths: string[];
}

interface PendingToolChange {
    checkpointId: string;
    path: string;
    before: { existed: boolean; content: string };
}

function calculateTextChange(
    path: string,
    before: { existed: boolean; content: string },
    after: { existed: boolean; content: string },
): RestoreChange | undefined {
    if (before.existed === after.existed && before.content === after.content) return undefined;
    const patch = generateUnifiedPatch(path, before.content, after.content);
    const additions = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    return { path, additions, deletions };
}

/** 在工具执行边界采集正向变化；失败工具只清除临时状态，不写入 Manifest。 */
export class ToolChangeTracker {
    private readonly store: CheckpointStore;
    private readonly pending = new Map<string, PendingToolChange>();

    constructor(store: CheckpointStore) {
        this.store = store;
    }

    async begin(toolCallId: string, checkpointId: string, filePath: string): Promise<void> {
        const inspected = await this.store.inspectWorkingFile(filePath);
        if (!inspected) return;
        this.pending.set(toolCallId, {
            checkpointId,
            path: inspected.path,
            before: { existed: inspected.existed, content: inspected.content },
        });
    }

    async complete(toolCallId: string, isError: boolean): Promise<void> {
        const pending = this.pending.get(toolCallId);
        this.pending.delete(toolCallId);
        if (!pending || isError) return;
        const inspected = await this.store.inspectWorkingFile(pending.path);
        if (!inspected) return;
        const change = calculateTextChange(pending.path, pending.before, {
            existed: inspected.existed,
            content: inspected.content,
        });
        if (change) await this.store.recordTurnChange(pending.checkpointId, change);
    }
}

export interface RestoreTransaction {
    result: RestoreResult;
    rollback(): Promise<void>;
}

/** 将 RestorePlan 应用到工作区；链接和非普通文件只报告、不改写。 */
export class FileRestorer {
    private readonly store: CheckpointStore;

    constructor(store: CheckpointStore) {
        this.store = store;
    }

    async restore(checkpointId: string): Promise<RestoreResult> {
        return (await this.restoreWithRollback(checkpointId)).result;
    }

    async restoreWithRollback(checkpointId: string): Promise<RestoreTransaction> {
        const plan = await this.store.buildRestorePlan(checkpointId);
        const result: RestoreResult = { restored: 0, skipped: 0, failed: 0, skippedPaths: [] };
        const operations: Array<{
            absolutePath: string;
            snapshot: SnapshotRef;
            content?: Buffer;
            rollback: { existed: boolean; content?: Buffer; mode?: number };
        }> = [];
        const noRollback = async () => {};

        // 先读取所有目标 Blob 和当前内容，任何预检失败都不会触碰工作区。
        try {
            for (const [trackedPath, snapshot] of plan) {
                const absolutePath = await this.store.resolveRestorePath(
                    trackedPath,
                    snapshot.parentRealPath,
                );
                if (!absolutePath || snapshot.unsupported || (await this.currentPathIsUnsupported(absolutePath))) {
                    result.skipped++;
                    result.skippedPaths.push(trackedPath);
                    continue;
                }
                const rollback = await this.readCurrentState(absolutePath);
                let content: Buffer | undefined;
                if (snapshot.existed) {
                    if (!snapshot.blobSha256) throw new Error(`Missing blob for ${trackedPath}`);
                    content = await this.store.readBlob(snapshot.blobSha256);
                }
                operations.push({ absolutePath, snapshot, content, rollback });
            }
        } catch {
            result.failed = 1;
            return { result, rollback: noRollback };
        }

        const applied: typeof operations = [];
        try {
            for (const operation of operations) {
                await this.applyState(operation.absolutePath, {
                    existed: operation.snapshot.existed,
                    content: operation.content,
                    mode: operation.snapshot.mode,
                });
                applied.push(operation);
            }
            result.restored = operations.length;
        } catch {
            result.failed = 1;
            await this.rollbackOperations(applied, false);
            return { result, rollback: noRollback };
        }

        let rolledBack = false;
        return {
            result,
            rollback: async () => {
                if (rolledBack) return;
                rolledBack = true;
                await this.rollbackOperations(operations, true);
            },
        };
    }

    private async rollbackOperations(
        operations: Array<{ absolutePath: string; rollback: { existed: boolean; content?: Buffer; mode?: number } }>,
        throwOnFailure: boolean,
    ): Promise<void> {
        const failedPaths: string[] = [];
        for (const operation of [...operations].reverse()) {
            try {
                await this.applyState(operation.absolutePath, operation.rollback);
            } catch {
                failedPaths.push(operation.absolutePath);
            }
        }
        if (throwOnFailure && failedPaths.length > 0) {
            throw new Error(`Failed to roll back ${failedPaths.length} restored file(s)`);
        }
    }

    private async readCurrentState(
        absolutePath: string,
    ): Promise<{ existed: boolean; content?: Buffer; mode?: number }> {
        try {
            const stat = await lstat(absolutePath);
            return { existed: true, content: await readFile(absolutePath), mode: stat.mode };
        } catch (error) {
            if (isMissing(error)) return { existed: false };
            throw error;
        }
    }

    private async applyState(
        absolutePath: string,
        state: { existed: boolean; content?: Buffer; mode?: number },
    ): Promise<void> {
        if (!state.existed) {
            await rm(absolutePath, { force: true });
            return;
        }
        if (!state.content) throw new Error(`Missing restore content for ${absolutePath}`);
        await mkdir(dirname(absolutePath), { recursive: true });
        const tempPath = `${absolutePath}.rewind-${randomUUID()}.tmp`;
        await writeFile(tempPath, state.content, { mode: state.mode ?? 0o600 });
        await rename(tempPath, absolutePath);
        if (state.mode !== undefined) await chmod(absolutePath, state.mode);
    }

    private async currentPathIsUnsupported(absolutePath: string): Promise<boolean> {
        try {
            const stat = await lstat(absolutePath);
            return stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1;
        } catch (error) {
            if (isMissing(error)) return false;
            throw error;
        }
    }
}

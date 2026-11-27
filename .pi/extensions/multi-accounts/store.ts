import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { QuotaState } from "./quota.ts";

export interface QuotaObservation { credential: string; state: QuotaState; }
import type { Credential } from "@earendil-works/pi-ai";

export interface Account {
    id: string;
    label: string;
    credential: Credential;
    enabled: boolean;
    blockedModels: string[];
    quotaResets?: Record<string, number>;
}
export interface Pool {
    accounts: Account[];
    active?: string;
    generation: number;
    auto: boolean;
}
interface Database { version: 1; providers: Record<string, Pool>; }
export interface Snapshot { pool: Pool; current?: Credential; }
export function fingerprint(value: Credential | undefined): string {
    return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}
function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
export function isCredential(value: unknown): value is Credential {
    if (!record(value)) return false;
    if (value.type === "oauth") return typeof value.access === "string" && !!value.access
        && typeof value.refresh === "string" && !!value.refresh && typeof value.expires === "number" && Number.isFinite(value.expires);
    return value.type === "api_key"
        && (value.key === undefined || typeof value.key === "string")
        && (value.env === undefined || (record(value.env) && Object.values(value.env).every(item => typeof item === "string")));
}
function identity(value: Credential): string | undefined {
    if (value.type !== "oauth") return undefined;
    try {
        const payload = JSON.parse(Buffer.from(value.access.split(".")[1], "base64url").toString());
        const workspace = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (typeof payload.sub === "string" && typeof workspace === "string") return `${payload.sub}:${workspace}`;
    } catch { /* 非 JWT 凭据依靠完整对象和用户显式关联，不猜测身份。 */ }
    return undefined;
}
function emptyPool(): Pool { return { accounts: [], generation: 0, auto: false }; }

export class AccountStore {
    readonly authPath: string;
    readonly databasePath: string;
    readonly agentDir: string;
    constructor(agentDir: string) {
        this.agentDir = agentDir;
        this.authPath = join(agentDir, "auth.json");
        this.databasePath = join(agentDir, "multi-accounts", "accounts.json");
    }
    private async json(path: string, fallback: unknown): Promise<unknown> {
        try { return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
            throw new Error(`无法读取账号文件：${path}，请检查格式或权限。`);
        }
    }
    private async load(): Promise<{ auth: Record<string, unknown>; db: Database }> {
        const auth = await this.json(this.authPath, {});
        // 仅新文件不存在时兼容旧库；新库损坏不能回退到可能过期的旧凭据。
        const currentDatabase = await this.json(this.databasePath, undefined);
        const db = currentDatabase === undefined
            ? await this.json(join(this.agentDir, "provider-accounts", "accounts.json"), { version: 1, providers: {} })
            : currentDatabase;
        if (!record(auth) || !record(db) || db.version !== 1 || !record(db.providers)) throw new Error("账号文件格式无效，未修改文件。");
        for (const pool of Object.values(db.providers)) {
            if (!record(pool) || !Array.isArray(pool.accounts) || typeof pool.auto !== "boolean"
                || !Number.isSafeInteger(pool.generation) || (pool.generation as number) < 0
                || (pool.active !== undefined && typeof pool.active !== "string")) throw new Error("账号库格式无效。");
            const ids = new Set<string>();
            for (const account of pool.accounts) {
                if (!record(account) || typeof account.id !== "string" || ids.has(account.id)
                    || typeof account.label !== "string" || typeof account.enabled !== "boolean"
                    || !Array.isArray(account.blockedModels) || !account.blockedModels.every(x => typeof x === "string")
                    || !isCredential(account.credential)) throw new Error("账号库中存在无效或重复账号。");
                if (account.quotaResets !== undefined && (!record(account.quotaResets)
                    || !Object.values(account.quotaResets).every(time => typeof time === "number" && Number.isFinite(time) && time > 0))) throw new Error("账号重置时间格式无效。");
                const resets = account.quotaResets as Record<string, number> | undefined;
                // 到期仅解除本地历史限制，是否真正恢复仍由服务端探测确认。
                for (const [model, time] of Object.entries(resets ?? {})) {
                    if (time <= Date.now()) {
                        account.blockedModels = (account.blockedModels as string[]).filter(item => item !== model);
                        delete resets![model];
                    }
                }
                ids.add(account.id);
            }
        }
        return { auth, db: db as unknown as Database };
    }
    private reconcile(pool: Pool, current?: Credential): Account | undefined {
        if (!current) return undefined;
        const sameIdentity = (account: Account) => identity(current) !== undefined && identity(account.credential) === identity(current);
        const match = pool.accounts.find(a => fingerprint(a.credential) === fingerprint(current))
            ?? pool.accounts.find(a => a.id === pool.active && sameIdentity(a))
            ?? pool.accounts.find(sameIdentity);
        if (match) match.credential = current;
        return match;
    }
    async list(): Promise<string[]> {
        const { auth, db } = await this.load();
        return [...new Set([...Object.keys(auth).filter(key => isCredential(auth[key])), ...Object.keys(db.providers)])];
    }
    async snapshot(provider: string): Promise<Snapshot> {
        const { auth, db } = await this.load();
        const pool = db.providers[provider] ?? emptyPool();
        const current = isCredential(auth[provider]) ? auth[provider] : undefined;
        pool.active = this.reconcile(pool, current)?.id;
        return { pool, current };
    }
    private async transaction<T>(provider: string, fn: (pool: Pool, current: Credential | undefined) => T, activate = false): Promise<T> {
        await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
        // 排他创建避免并发初始化覆盖宿主已有凭据；锁协议与 Pi 1.6.0 相同。
        const file = await open(this.authPath, "ax", 0o600).catch(error => {
            if (error.code !== "EEXIST") throw error;
            return undefined;
        });
        if (file) { await file.writeFile("{}"); await file.close(); }
        let compromised = false;
        const release = await lockfile.lock(this.authPath, { stale: 30_000, retries: { retries: 65, factor: 1, minTimeout: 500, maxTimeout: 500 }, onCompromised: () => { compromised = true; } });
        try {
            const { auth, db } = await this.load();
            const pool = db.providers[provider] ?? emptyPool();
            const value = auth[provider];
            if (value !== undefined && !isCredential(value)) throw new Error("当前 provider 凭据格式不支持，未修改文件。");
            const current = value as Credential | undefined;
            const known = this.reconcile(pool, current);
            if (pool.active !== known?.id) pool.generation++;
            pool.active = known?.id;
            const result = fn(pool, current);
            db.providers[provider] = pool;
            if (compromised) throw new Error("账号文件锁失效，已停止写入。");
            await mkdir(join(this.agentDir, "multi-accounts"), { recursive: true, mode: 0o700 });
            // 先归档最新凭据，再覆盖活动槽位；两文件不是原子事务，恢复以 auth 为准。
            const temporary = `${this.databasePath}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify(db, null, 4), { mode: 0o600 });
            await rename(temporary, this.databasePath);
            if (compromised) throw new Error("账号文件锁失效，已停止写入。");
            if (activate && pool.active) {
                const next = pool.accounts.find(a => a.id === pool.active)!;
                auth[provider] = next.credential;
                await writeFile(this.authPath, JSON.stringify(auth, null, 4), { mode: 0o600 });
            }
            return result;
        } finally { await release(); }
    }
    async save(provider: string, credential: Credential, label: string, activate = false): Promise<string> {
        if (!isCredential(credential) || !label.trim() || /[\x00-\x1f\x7f]/.test(label)) throw new Error("账号名称或凭据无效。");
        return this.transaction(provider, (pool, current) => {
            if (current && !pool.active) {
                const importingCurrent = fingerprint(current) === fingerprint(credential);
                const old: Account = { id: randomUUID(), label: importingCurrent ? label.trim() : "现有账号", credential: current, enabled: true, blockedModels: [] };
                pool.accounts.push(old); pool.active = old.id;
            }
            // 仅保存的新凭据必须独立暂存，不能通过身份匹配改掉当前槽位。
            let account = pool.accounts.find(item => fingerprint(item.credential) === fingerprint(credential));
            if (!account) {
                account = { id: randomUUID(), label: label.trim(), credential, enabled: true, blockedModels: [] };
                pool.accounts.push(account);
            }
            if (activate) { pool.active = account.id; pool.generation++; }
            return account.id;
        }, activate);
    }
    async use(provider: string, id: string, expected?: string): Promise<void> {
        await this.transaction(provider, (pool, current) => {
            if (expected !== undefined && fingerprint(current) !== expected) throw new Error("当前账号已变化，请重新确认切换。");
            if (current && !pool.active) {
                pool.accounts.push({ id: randomUUID(), label: "现有账号", credential: current, enabled: true, blockedModels: [] });
            }
            const account = pool.accounts.find(a => a.id === id);
            if (!account || !account.enabled) throw new Error("目标账号不存在或未参与轮换，请先启用。");
            pool.active = id; pool.generation++;
        }, true);
    }
    async update(provider: string, action: (pool: Pool) => void): Promise<void> {
        await this.transaction(provider, pool => { action(pool); });
    }
    async rotate(provider: string, expected: string, generation: number, model: string, resetAt?: number,
        observations?: Map<string, QuotaObservation>): Promise<boolean> {
        return this.transaction(provider, (pool, current) => {
            if (!pool.auto || !pool.active || fingerprint(current) !== expected || generation !== pool.generation) return false;
            const index = pool.accounts.findIndex(a => a.id === pool.active);
            const old = pool.accounts[index];
            if (!old.blockedModels.includes(model)) old.blockedModels.push(model);
            old.quotaResets ??= {};
            if (resetAt !== undefined && resetAt > Date.now()) old.quotaResets[model] = resetAt;
            else delete old.quotaResets[model];
            // 网络探测在锁外执行；发布前重新核对凭据，避免覆盖并发重登后的状态。
            for (const account of pool.accounts) {
                const observation = observations?.get(account.id);
                if (!observation || observation.credential !== fingerprint(account.credential)) continue;
                account.quotaResets ??= {};
                if (observation.state.available) {
                    account.blockedModels = account.blockedModels.filter(item => item !== model);
                    delete account.quotaResets[model];
                } else {
                    if (!account.blockedModels.includes(model)) account.blockedModels.push(model);
                    if (observation.state.resetAt !== undefined && observation.state.resetAt > Date.now()) account.quotaResets[model] = observation.state.resetAt;
                    else delete account.quotaResets[model];
                }
            }
            for (let n = 1; n < pool.accounts.length; n++) {
                const next = pool.accounts[(index + n) % pool.accounts.length];
                const observed = observations?.get(next.id);
                if (observations && (!observed?.state.available || observed.credential !== fingerprint(next.credential))) continue;
                if (next.enabled && !next.blockedModels.includes(model)) { pool.active = next.id; pool.generation++; return true; }
            }
            return false;
        }, true);
    }
}

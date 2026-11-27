import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { Input, CURSOR_MARKER, truncateToWidth } from "@earendil-works/pi-tui";
import type { AuthInteraction, AuthPrompt, Credential, Provider } from "@earendil-works/pi-ai";
import { AccountStore, fingerprint } from "./store.ts";
import { wrapCodex } from "./stream.ts";

type Choice<T> = { label: string; value: T };
async function choose<T>(ctx: ExtensionContext, title: string, choices: Choice<T>[]): Promise<T | undefined> {
    // select 返回文本，不依赖标签唯一性；编号映射到原始对象。
    const rows = choices.map((choice, index) => `${index + 1}. ${choice.label}`);
    const answer = await ctx.ui.select(title, rows);
    return answer === undefined ? undefined : choices[rows.indexOf(answer)]?.value;
}
function validateLabel(ctx: ExtensionContext, label: string | undefined): string | undefined {
    if (label === undefined) return undefined;
    if (!label.trim() || /[\x00-\x1f\x7f]/.test(label)) {
        ctx.ui.notify("账号名称不能为空或包含控制字符。", "warning");
        return undefined;
    }
    return label.trim();
}
function interaction(ctx: ExtensionContext, signal: AbortSignal, waitForDevice: () => void): AuthInteraction & { signal: AbortSignal } {
    return {
        signal,
        prompt: async (prompt: AuthPrompt) => {
            const options = { signal: prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal };
            let answer: string | undefined;
            if (prompt.type === "select") {
                const rows = prompt.options.map((option, index) => `${index + 1}. ${option.label}`);
                const selected = await ctx.ui.select(prompt.message, rows, options);
                answer = selected === undefined ? undefined : prompt.options[rows.indexOf(selected)]?.id;
            } else {
                if (prompt.type === "secret") {
                    if (ctx.mode !== "tui") throw new Error("保密输入需要终端交互模式。");
                    answer = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
                        const input = new Input();
                        input.onSubmit = done;
                        input.onEscape = () => done(undefined);
                        const abort = () => done(undefined);
                        options.signal.addEventListener("abort", abort, { once: true });
                        if (options.signal.aborted) done(undefined);
                        return {
                            focused: true,
                            render: (width: number) => [truncateToWidth(prompt.message, width), `${"*".repeat(Math.min(input.getValue().length, Math.max(0, width - 1)))}${CURSOR_MARKER}`],
                            handleInput: (data: string) => { input.handleInput(data); tui.requestRender(); },
                            invalidate: () => {},
                            dispose: () => options.signal.removeEventListener("abort", abort),
                        };
                    }, { blocked: { kind: "auth", message: "输入登录凭据" } });
                } else answer = await ctx.ui.input(prompt.message, prompt.placeholder, options);
            }
            if (answer === undefined) throw new Error("登录已取消。");
            return answer;
        },
        notify: event => {
            if (event.type === "auth_url") ctx.ui.notify(`请在浏览器打开授权地址：\n${event.url}`, "info");
            else if (event.type === "device_code") {
                ctx.ui.notify(`打开 ${event.verificationUri}，输入设备码 ${event.userCode}`, "info");
                waitForDevice();
            }
            else ctx.ui.notify(event.message, "info");
        },
    };
}
export default function multiAccounts(pi: ExtensionAPI, store = new AccountStore(getAgentDir())) {
    let context: ExtensionContext | undefined;
    let wrapped = false;
    async function refresh(ctx: ExtensionContext, provider: string) {
        await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [provider] });
        const { pool, current } = await store.snapshot(provider);
        const active = pool.accounts.find(a => a.id === pool.active);
        ctx.ui.setStatus("multi-accounts", current ? `${ctx.modelRegistry.getProviderDisplayName(provider)} · ${active?.label ?? "现有账号"}` : undefined);
    }
    pi.on("session_start", async (_event, ctx) => {
        context = ctx;
        if (VERSION !== "1.6.0") { ctx.ui.notify("账号管理尚未验证此 Pi 版本的文件锁协议，已禁用写入。", "warning"); return; }
        if (!wrapped) {
            const base = ctx.modelRegistry.getProvider("openai-codex");
            if (base) {
                pi.registerProvider(wrapCodex(base, store,
                    async () => (await context?.modelRegistry.getProviderAuth("openai-codex"))?.auth.apiKey,
                    message => context?.ui.notify(message, "info")));
                wrapped = true;
            }
        }
        if (ctx.model) await refresh(ctx, ctx.model.provider).catch(() => ctx.ui.notify("账号库读取失败，请通过 /multi-accounts 检查。", "warning"));
    });
    pi.on("model_select", async (_event, ctx) => { if (ctx.model) await refresh(ctx, ctx.model.provider); });
    async function login(ctx: ExtensionCommandContext, provider: Provider, target?: string) {
        const label = validateLabel(ctx, await ctx.ui.input("账号名称"));
        if (label === undefined) return;
        const before = await store.snapshot(provider.id);
        const methods = [
            ...(provider.auth.oauth ? [{ label: provider.auth.oauth.name, value: "oauth" as const }] : []),
            ...(provider.auth.apiKey?.login ? [{ label: provider.auth.apiKey.name, value: "api_key" as const }] : []),
        ];
        const method = methods.length === 1 ? methods[0].value : await choose(ctx, "登录方式", methods);
        if (!method) return;
        const controller = new AbortController();
        let finishWait: (() => void) | undefined;
        let waiting: Promise<void> | undefined;
        const ui = interaction(ctx, controller.signal, () => {
            if (ctx.mode !== "tui") throw new Error("设备授权等待需要终端交互模式。");
            if (waiting) return;
            waiting = ctx.ui.custom<void>((_tui, _theme, keys, done) => {
                finishWait = () => done();
                return {
                    render: (width: number) => [truncateToWidth("等待设备授权完成，取消键可终止登录。", width)],
                    handleInput: (data: string) => {
                        if (keys.matches(data, "tui.select.cancel")) {
                            controller.abort();
                            done();
                        }
                    },
                    invalidate: () => {},
                };
            }, { blocked: { kind: "auth", message: "等待设备授权" } });
        });
        let credential: Credential;
        try {
            credential = method === "oauth" ? await provider.auth.oauth!.login(ui) : await provider.auth.apiKey!.login!(ui);
        } catch (error) {
            if (controller.signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.message === "登录已取消。"))) return;
            throw error;
        } finally {
            finishWait?.();
            controller.abort();
            await waiting;
        }
        // 重登身份无法可靠通用判断，因此保存新槽位，不无条件覆盖指定旧账号。
        const id = await store.save(provider.id, credential, label);
        const now = await store.snapshot(provider.id);
        if (target) ctx.ui.notify("凭据已保存；请确认账号身份后切换，原账号归档未删除。", "info");
        if (fingerprint(before.current) !== fingerprint(now.current) || before.pool.generation !== now.pool.generation) {
            ctx.ui.notify("当前账号状态已变化，新账号仅保存，未自动切换。", "info"); return;
        }
        const action = await choose(ctx, "账号已保存", [{ label: "仅保存", value: false }, { label: "保存并全局切换", value: true }]);
        if (action) { await ctx.waitForIdle(); await store.use(provider.id, id, fingerprint(now.current)); await refresh(ctx, provider.id); }
    }
    async function accounts(ctx: ExtensionCommandContext, providerId: string) {
        const provider = ctx.modelRegistry.getProvider(providerId);
        while (true) {
            const { pool, current } = await store.snapshot(providerId);
            const rows: Choice<string>[] = pool.accounts.map(account => ({
                label: `${account.label} #${account.id.slice(0, 8)} · ${account.id === pool.active ? "当前" : account.enabled ? "待用" : "不参与轮换"}${account.blockedModels.length ? " · 额度受限" : ""}`,
                value: account.id,
            }));
            if (current && !pool.active) rows.unshift({ label: "现有登录账号 · 当前（保存/命名）", value: "$import" });
            if (provider?.auth.oauth || provider?.auth.apiKey?.login) rows.push({ label: "添加账号", value: "$add" });
            rows.push({ label: "选择 / 添加 Provider", value: "$providers" });
            if (providerId === "openai-codex") rows.push({ label: `自动轮换：${pool.auto ? "开" : "关"}`, value: "$auto" });
            if (!rows.length) { ctx.ui.notify("此 Provider 没有文件登录账号或可用的内置登录接口。", "info"); return; }
            const selected = await choose(ctx, `${provider?.name ?? providerId} · 全局账号`, rows);
            if (!selected) return;
            if (selected === "$providers") return true;
            if (selected === "$add") { await login(ctx, provider!); continue; }
            if (selected === "$import") {
                const label = validateLabel(ctx, await ctx.ui.input("当前账号名称", "现有账号"));
                if (label !== undefined && current) {
                    await store.save(providerId, current, label);
                    await refresh(ctx, providerId);
                }
                continue;
            }
            if (selected === "$auto") {
                if (!pool.auto && !await ctx.ui.confirm("启用全局自动轮换？", "明确额度耗尽时将请求发送给其他账号，并影响同目录下其他 Pi 会话。自动轮换使用 SSE，仅支持内置 Codex 认证。")) continue;
                await store.update(providerId, latest => { latest.auto = !latest.auto; }); continue;
            }
            const account = pool.accounts.find(a => a.id === selected)!;
            const actions: Choice<string>[] = [
                ...(account.id !== pool.active && account.enabled ? [{ label: "切换到此账号（全局）", value: "use" }] : []),
                { label: "重命名", value: "rename" },
                ...(account.id !== pool.active ? [{ label: account.enabled ? "暂停参与轮换" : "启用参与轮换", value: "enable" }] : []),
                ...(account.blockedModels.length ? [{ label: "允许再次尝试（不会恢复服务端额度）", value: "retry" }] : []),
                { label: "上移轮换顺序", value: "up" }, { label: "下移轮换顺序", value: "down" },
                ...(provider?.auth.oauth || provider?.auth.apiKey?.login ? [{ label: "重新登录并保存凭据", value: "login" }] : []),
                ...(account.id !== pool.active ? [{ label: "删除本地账号", value: "remove" }] : []),
            ];
            const action = await choose(ctx, `${account.label} #${account.id.slice(0, 8)}`, actions);
            if (!action) continue;
            if (action === "use") { await ctx.waitForIdle(); await store.use(providerId, account.id); await refresh(ctx, providerId); ctx.ui.notify(`已全局切换至 ${account.label}`, "info"); return; }
            if (action === "login") { await login(ctx, provider!, account.id); continue; }
            let label: string | undefined;
            if (action === "rename") {
                label = validateLabel(ctx, await ctx.ui.input("新名称"));
                if (label === undefined) continue;
            }
            if (action === "remove" && !await ctx.ui.confirm("删除本地账号？", `删除「${account.label}」，不会撤销远端授权。`)) continue;
            await store.update(providerId, latest => {
                const index = latest.accounts.findIndex(a => a.id === account.id);
                if (index < 0) throw new Error("账号已由其他进程移除，请刷新。");
                const item = latest.accounts[index];
                if ((action === "remove" || action === "enable") && latest.active === item.id) throw new Error("当前账号不可删除或禁用，请先切换。");
                if (action === "remove") latest.accounts.splice(index, 1);
                if (action === "enable") item.enabled = !item.enabled;
                if (action === "rename") item.label = label!.trim();
                if (action === "retry") { item.blockedModels = []; item.quotaResets = {}; }
                const next = action === "up" ? index - 1 : action === "down" ? index + 1 : -1;
                if (next >= 0 && next < latest.accounts.length) [latest.accounts[index], latest.accounts[next]] = [latest.accounts[next], latest.accounts[index]];
            });
            if (action === "rename") await refresh(ctx, providerId);
        }
    }
    pi.registerCommand("multi-accounts", {
        description: "交互式管理 Provider 多账号（切换全局生效）",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) throw new Error("/multi-accounts 需要交互式 UI。");
            if (VERSION !== "1.6.0") { ctx.ui.notify("当前仅验证 Pi 1.6.0，已停止账号写入。", "error"); return; }
            context = ctx;
            try {
                const existing = await store.list();
                const registered = [...new Set([
                    ...ctx.modelRegistry.getAll().map(model => model.provider),
                    ...ctx.modelRegistry.getModelsOfType("image").map(model => model.provider),
                    ...ctx.modelRegistry.getModelsOfType("classifier").map(model => model.provider),
                    ...existing.filter(id => ctx.modelRegistry.getProvider(id) !== undefined),
                ])];
                const ids = existing.filter(id => registered.includes(id));
                if (ids.length === 1 && !await accounts(ctx, ids[0])) return;
                while (true) {
                    const choices: Choice<string>[] = await Promise.all((await store.list()).map(async id => {
                        const snapshot = await store.snapshot(id);
                        return { label: `${ctx.modelRegistry.getProviderDisplayName(id)} · ${snapshot.current ? "已登录" : "未登录"} · 已保存 ${snapshot.pool.accounts.length} 个`, value: id };
                    }));
                    choices.push({ label: "添加 Provider", value: "$add" });
                    let id = await choose(ctx, "Provider 账号管理", choices);
                    if (!id) return;
                    if (id === "$add") {
                        const candidates = registered.filter(key => { const p = ctx.modelRegistry.getProvider(key); return p?.auth.oauth || p?.auth.apiKey?.login; });
                        id = await choose(ctx, "选择 Provider", candidates.map(key => ({ label: ctx.modelRegistry.getProviderDisplayName(key), value: key })));
                        if (!id) continue;
                    }
                    await accounts(ctx, id);
                }
            } catch { ctx.ui.notify("账号操作失败或已取消。请检查账号文件、权限或登录方式；未显示底层错误以避免泄露凭据。", "error"); }
        },
    });
}

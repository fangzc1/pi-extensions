import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandLaunchMode = "auto" | "direct" | "zsh-rc";
export type AgyEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const AGY_EFFORT_LEVELS: readonly AgyEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export interface AntigravityCliConfig {
    /** 底层调用命令，默认 "agy"，支持自定义为可执行文件路径或 ~/.zshrc 中的函数/alias（如 "a"） */
    command: string;
    /** 启动模式：auto 自动探测；direct 直接执行；zsh-rc 加载 ~/.zshrc 后执行 */
    launchMode: CommandLaunchMode;
    /** 开启 agy 时使用的模型 slug（可为家族基础名如 gemini-4-neon 或完整变体名）；留空跟随 agy 默认 */
    model?: string;
    /** 开启 agy 时使用的思考级别（low|medium|high|xhigh|max）；留空跟随默认 */
    effort?: AgyEffortLevel;
    /** 附加透传给底层命令的参数列表 */
    extraArgs: string[];
    /** 每轮完成后是否以精简问答同步进 Pi 主模型上下文 */
    syncSummaryToMainModel: boolean;
}

export interface AgyModelEntry {
    slug: string;
    label: string;
}

export interface AgyModelFamily {
    /** 传给 --model 的基础 slug（固定预算模型等于其原始 slug） */
    id: string;
    /** 展示名称（去掉尾部思考级别括号后的名称） */
    label: string;
    /** 该模型支持的思考级别，按 low -> max 排序；空数组表示固定思考预算不支持 --effort */
    efforts: AgyEffortLevel[];
    /** 原始变体映射（按 effort 查对应 slug） */
    variants: Partial<Record<AgyEffortLevel, string>>;
}

export interface CommandProbeOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    zshPath?: string;
    rcFile?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface CommandProbeResult {
    ok: boolean;
    resolvedMode?: "direct" | "zsh-rc";
    resolvedPath?: string;
    shellKind?: string;
    zshPath?: string;
    rcFile?: string;
    error?: string;
}

export const DEFAULT_CONFIG: Readonly<AntigravityCliConfig> = Object.freeze({
    command: "agy",
    launchMode: "auto",
    extraArgs: [],
    syncSummaryToMainModel: true,
});

const UNSAFE_COMMAND_PATTERN = /[\x00-\x1f\x7f\s;|&$`<>(){}*?!'"\\]/;
const VALID_LAUNCH_MODES = new Set<CommandLaunchMode>(["auto", "direct", "zsh-rc"]);
const VALID_EFFORT_LEVELS = new Set<AgyEffortLevel>(AGY_EFFORT_LEVELS);
const VALID_ZSH_KINDS = new Set(["function", "alias", "command", "hashed", "builtin"]);
const EFFORT_SLUG_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/i;
const EFFORT_LABEL_SUFFIX = /\s*\((Low|Medium|High|XHigh|Max)\)\s*$/i;
const MODEL_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

export function cloneDefaultConfig(): AntigravityCliConfig {
    return {
        command: DEFAULT_CONFIG.command,
        launchMode: DEFAULT_CONFIG.launchMode,
        extraArgs: [...DEFAULT_CONFIG.extraArgs],
        syncSummaryToMainModel: DEFAULT_CONFIG.syncSummaryToMainModel,
    };
}

/** 校验模型 slug，禁止空白或控制字符。 */
export function validateModelSlug(raw: string): { ok: true; value: string } | { ok: false; error: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "模型名称不能为空" };
    if (/[\x00-\x1f\x7f\s]/.test(trimmed)) {
        return { ok: false, error: "模型 slug 不能包含空白或控制字符" };
    }
    return { ok: true, value: trimmed };
}

/** 校验思考级别。 */
export function validateEffortLevel(raw: string): { ok: true; value: AgyEffortLevel } | { ok: false; error: string } {
    const normalized = raw.trim().toLowerCase();
    if (!VALID_EFFORT_LEVELS.has(normalized as AgyEffortLevel)) {
        return { ok: false, error: `思考级别必须是 ${AGY_EFFORT_LEVELS.join(" / ")} 之一` };
    }
    return { ok: true, value: normalized as AgyEffortLevel };
}

/**
 * 规整 --model 与 --effort 参数，避免向 agy 传入冲突组合（例如 --model gemini-4-neon-high --effort low）。
 * 实测 agy 接受基础模型名搭配 --effort（如 --model gemini-4-neon --effort low）。
 */
export function buildModelEffortArgs(model?: string, effort?: AgyEffortLevel): string[] {
    const normalizedModel = model?.trim();
    const args: string[] = [];

    if (normalizedModel && effort) {
        const suffixMatch = normalizedModel.match(EFFORT_SLUG_SUFFIX);
        const baseModel = suffixMatch ? suffixMatch[1]! : normalizedModel;
        args.push("--model", baseModel, "--effort", effort);
        return args;
    }
    if (normalizedModel) {
        args.push("--model", normalizedModel);
    }
    if (effort) {
        args.push("--effort", effort);
    }
    return args;
}

/** 从 `agy models`（或 `a models`）标准输出中解析可用模型清单，自动跳过 proxyctl 等前置杂音行。 */
export function parseAgyModelsOutput(stdout: string): AgyModelEntry[] {
    const entries: AgyModelEntry[] = [];
    const seen = new Set<string>();

    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        // agy models 在非 TTY 下输出 "<slug>\t<Label>"，TTY 下为两空格以上对齐。
        const match = line.match(/^([^\s]+)(?:\t+|\s{2,})(.+)$/);
        if (!match) continue;
        const slug = match[1]!.trim();
        const label = match[2]!.trim();
        if (!MODEL_SLUG_PATTERN.test(slug) || seen.has(slug)) continue;
        seen.add(slug);
        entries.push({ slug, label });
    }
    return entries;
}

/** 将 `agy models` 变体列表按模型家族分组，便于先选模型再选该模型实际支持的思考级别。 */
export function groupModelCatalog(entries: readonly AgyModelEntry[]): AgyModelFamily[] {
    const families = new Map<string, AgyModelFamily>();

    for (const entry of entries) {
        const slugMatch = entry.slug.match(EFFORT_SLUG_SUFFIX);
        const labelHasEffort = EFFORT_LABEL_SUFFIX.test(entry.label);
        if (slugMatch && labelHasEffort) {
            const baseSlug = slugMatch[1]!;
            const effort = slugMatch[2]!.toLowerCase() as AgyEffortLevel;
            const baseLabel = entry.label.replace(EFFORT_LABEL_SUFFIX, "").trim() || baseSlug;
            let family = families.get(baseSlug);
            if (!family) {
                family = { id: baseSlug, label: baseLabel, efforts: [], variants: {} };
                families.set(baseSlug, family);
            }
            if (!family.efforts.includes(effort)) {
                family.efforts.push(effort);
            }
            family.variants[effort] = entry.slug;
        } else if (!families.has(entry.slug)) {
            families.set(entry.slug, {
                id: entry.slug,
                label: entry.label,
                efforts: [],
                variants: {},
            });
        }
    }

    const order = new Map(AGY_EFFORT_LEVELS.map((level, index) => [level, index]));
    for (const family of families.values()) {
        family.efforts.sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
    }
    return [...families.values()];
}

function killChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform !== "win32") {
        try {
            process.kill(-pid, signal);
            return;
        } catch {
            // 回退单进程信号。
        }
    }
    try {
        child.kill(signal);
    } catch {
        // 忽略已退出进程。
    }
}

function runCommandForStdout(
    executable: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: true; stdout: string } | { ok: false; aborted?: boolean; timedOut?: boolean; error: string }> {
    return new Promise((resolvePromise) => {
        if (options.signal?.aborted) {
            resolvePromise({ ok: false, aborted: true, error: "已取消拉取模型列表" });
            return;
        }

        const detached = process.platform !== "win32";
        const child = spawn(executable, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached,
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (
            outcome: { ok: true; stdout: string } | { ok: false; aborted?: boolean; timedOut?: boolean; error: string },
        ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);
            options.signal?.removeEventListener("abort", onAbort);
            resolvePromise(outcome);
        };

        const terminateGroup = () => {
            killChildGroup(child, "SIGTERM");
            const hardKill = setTimeout(() => {
                if (child.exitCode === null) killChildGroup(child, "SIGKILL");
            }, 500);
            hardKill.unref?.();
        };

        const onAbort = () => {
            terminateGroup();
            finish({ ok: false, aborted: true, error: "已取消拉取模型列表" });
        };

        options.signal?.addEventListener("abort", onAbort, { once: true });

        const timeoutTimer = setTimeout(() => {
            terminateGroup();
            finish({
                ok: false,
                timedOut: true,
                error: "拉取可用模型超时（若本机需代理，请先将底层命令改为 a 或开启终端代理）",
            });
        }, options.timeoutMs);
        timeoutTimer.unref?.();

        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (error: Error) => {
            finish({ ok: false, error: `执行失败：${error.message}` });
        });
        child.on("close", (code: number | null) => {
            if (code === 0) {
                finish({ ok: true, stdout });
            } else {
                const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
                finish({
                    ok: false,
                    error: detail ? `退出码 ${code ?? "unknown"}：${detail}` : `退出码 ${code ?? "unknown"}`,
                });
            }
        });
    });
}

/** 通过当前配置的命令执行 `models` 子命令，动态获取本机可用模型列表（支持超时强杀与取消）。 */
export async function fetchAvailableModels(
    command: string,
    launchMode: CommandLaunchMode,
    options: CommandProbeOptions = {},
): Promise<{ ok: true; entries: AgyModelEntry[]; families: AgyModelFamily[] } | { ok: false; aborted?: boolean; error: string }> {
    const probe = await probeCommand(command, launchMode, options);
    if (!probe.ok || !probe.resolvedMode) {
        return { ok: false, error: probe.error ?? `无法探测命令 "${command}"` };
    }

    const env = { ...process.env, ...options.env };
    const timeoutMs = options.timeoutMs ?? 8_000;

    const runResult = probe.resolvedMode === "direct"
        ? await runCommandForStdout(probe.resolvedPath ?? command, ["models"], {
            cwd: options.cwd,
            env,
            timeoutMs,
            signal: options.signal,
        })
        : await runCommandForStdout(
            probe.zshPath ?? resolveZshPath(env),
            [
                "-c",
                '[[ -f "$1" ]] && source "$1" >/dev/null 2>&1; "$2" models',
                "pi-agy-models",
                probe.rcFile ?? resolveZshRcFile(env),
                command,
            ],
            {
                cwd: options.cwd,
                env,
                timeoutMs,
                signal: options.signal,
            },
        );

    if (!runResult.ok) {
        return {
            ok: false,
            aborted: runResult.aborted,
            error: runResult.aborted ? runResult.error : `获取可用模型列表失败：${runResult.error}`,
        };
    }

    const entries = parseAgyModelsOutput(runResult.stdout);
    if (entries.length === 0) {
        return { ok: false, error: `命令 "${command} models" 未返回可解析的模型列表` };
    }
    return { ok: true, entries, families: groupModelCatalog(entries) };
}

/** 校验命令名称或路径，禁止空白、控制字符和 shell 元字符。 */
export function validateCommand(raw: string): { ok: true; value: string } | { ok: false; error: string } {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { ok: false, error: "命令不能为空" };
    }
    if (UNSAFE_COMMAND_PATTERN.test(trimmed)) {
        return { ok: false, error: "命令不能包含空格、引号或 shell 控制字符；附加参数请单独配置" };
    }
    return { ok: true, value: trimmed };
}

/** 展开命令中的 ~ 前缀。 */
export function expandHomePath(input: string, home = homedir()): string {
    if (input === "~") return home;
    if (input.startsWith("~/")) return join(home, input.slice(2));
    return input;
}

/** 将用户输入的附加参数字符串解析为参数数组，支持单双引号与反斜杠转义。 */
export function parseExtraArgs(raw: string): { ok: true; args: string[] } | { ok: false; error: string } {
    const args: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let escaping = false;
    let hasToken = false;

    for (let index = 0; index < raw.length; index += 1) {
        const ch = raw[index]!;
        if (escaping) {
            current += ch;
            escaping = false;
            hasToken = true;
            continue;
        }
        if (inSingle) {
            if (ch === "'") {
                inSingle = false;
            } else {
                current += ch;
            }
            continue;
        }
        if (inDouble) {
            if (ch === "\"") {
                inDouble = false;
            } else if (ch === "\\") {
                const next = raw[index + 1];
                if (next === "\"" || next === "\\" || next === "$" || next === "`") {
                    escaping = true;
                } else {
                    current += ch;
                }
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === "\\") {
            escaping = true;
            hasToken = true;
            continue;
        }
        if (ch === "'") {
            inSingle = true;
            hasToken = true;
            continue;
        }
        if (ch === "\"") {
            inDouble = true;
            hasToken = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (hasToken) {
                args.push(current);
                current = "";
                hasToken = false;
            }
            continue;
        }
        current += ch;
        hasToken = true;
    }

    if (escaping || inSingle || inDouble) {
        return { ok: false, error: "附加参数存在未闭合的引号或转义符" };
    }
    if (hasToken) {
        args.push(current);
    }
    return { ok: true, args };
}

/** 将参数数组格式化为可回填编辑器的字符串。 */
export function formatExtraArgs(args: readonly string[]): string {
    return args
        .map((arg) => (/[\s"'\\]/.test(arg) || arg.length === 0 ? JSON.stringify(arg) : arg))
        .join(" ");
}

function isExecutableFile(filePath: string): boolean {
    try {
        const stats = statSync(filePath);
        if (!stats.isFile()) return false;
        accessSync(filePath, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** 在文件系统或 PATH 中查找可直接执行的命令。 */
export function resolveDirectExecutable(
    command: string,
    options: Pick<CommandProbeOptions, "cwd" | "env"> = {},
): string | undefined {
    const env = options.env ?? process.env;
    const home = env.HOME || homedir();
    const expanded = expandHomePath(command, home);

    if (expanded.includes("/")) {
        const candidate = isAbsolute(expanded) ? expanded : resolve(options.cwd ?? process.cwd(), expanded);
        return isExecutableFile(candidate) ? candidate : undefined;
    }

    const pathValue = env.PATH ?? "";
    for (const dir of pathValue.split(":")) {
        if (!dir) continue;
        const candidate = join(dir, expanded);
        if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
}

/** 解析本机可用的 zsh 路径。 */
export function resolveZshPath(env: NodeJS.ProcessEnv = process.env): string {
    const candidates = [
        env.SHELL && env.SHELL.endsWith("/zsh") ? env.SHELL : undefined,
        "/bin/zsh",
        "/usr/bin/zsh",
        "/opt/homebrew/bin/zsh",
        "/usr/local/bin/zsh",
    ];
    for (const candidate of candidates) {
        if (candidate && isExecutableFile(candidate)) return candidate;
    }
    return "zsh";
}

/** 解析用户默认 zshrc 路径。 */
export function resolveZshRcFile(env: NodeJS.ProcessEnv = process.env): string {
    const zdotdir = env.ZDOTDIR || env.HOME || homedir();
    return join(zdotdir, ".zshrc");
}

/** 通过非交互加载 zshrc 探测命令是否为函数、alias 或可执行命令。 */
export async function probeZshCommand(
    command: string,
    options: CommandProbeOptions = {},
): Promise<CommandProbeResult> {
    const env = options.env ?? process.env;
    const zshPath = options.zshPath ?? resolveZshPath(env);
    const rcFile = options.rcFile ?? resolveZshRcFile(env);
    const timeout = options.timeoutMs ?? 10_000;

    // 仅以位置参数传参，避免命令名拼入脚本引发 shell 注入。
    const probeScript = '[[ -f "$1" ]] && source "$1" >/dev/null 2>&1; whence -w -- "$2"';
    try {
        const { stdout } = await execFileAsync(
            zshPath,
            ["-c", probeScript, "pi-agy-probe", rcFile, command],
            { cwd: options.cwd, env, timeout },
        );
        const lines = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        const lastLine = lines.at(-1) ?? "";
        const match = lastLine.match(/:\s*([a-zA-Z0-9_-]+)$/);
        const kind = match?.[1];
        if (kind && VALID_ZSH_KINDS.has(kind)) {
            return {
                ok: true,
                resolvedMode: "zsh-rc",
                shellKind: kind,
                zshPath,
                rcFile,
            };
        }
        return {
            ok: false,
            zshPath,
            rcFile,
            error: `在 ${rcFile} 中未找到命令 "${command}"`,
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            zshPath,
            rcFile,
            error: `在 zsh (${rcFile}) 中探测 "${command}" 失败：${detail}`,
        };
    }
}

/** 按配置的启动模式探测命令是否可执行，并确定实际启动方式。 */
export async function probeCommand(
    command: string,
    launchMode: CommandLaunchMode,
    options: CommandProbeOptions = {},
): Promise<CommandProbeResult> {
    const checked = validateCommand(command);
    if (!checked.ok) {
        return { ok: false, error: checked.error };
    }
    const normalized = checked.value;

    if (launchMode === "direct") {
        const resolvedPath = resolveDirectExecutable(normalized, options);
        if (resolvedPath) {
            return { ok: true, resolvedMode: "direct", resolvedPath };
        }
        return {
            ok: false,
            error: `在 PATH 或文件系统中未找到可执行命令 "${normalized}"（如为 ~/.zshrc 函数请将启动模式设为 auto 或 zsh-rc）`,
        };
    }

    if (launchMode === "zsh-rc") {
        return probeZshCommand(normalized, options);
    }

    // auto 模式：优先直接执行（零 shell 启动开销），未命中时回退探测 ~/.zshrc 函数/alias。
    const directPath = resolveDirectExecutable(normalized, options);
    if (directPath) {
        return { ok: true, resolvedMode: "direct", resolvedPath: directPath };
    }

    const zshResult = await probeZshCommand(normalized, options);
    if (zshResult.ok) {
        return zshResult;
    }

    return {
        ok: false,
        error: `未找到命令 "${normalized}"（已检查 PATH 与 ${zshResult.rcFile ?? "~/.zshrc"}）`,
    };
}

function normalizeConfig(raw: unknown): AntigravityCliConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("配置根对象必须是 JSON Object");
    }
    const record = raw as Record<string, unknown>;
    const defaults = cloneDefaultConfig();

    let command = defaults.command;
    if (record.command !== undefined) {
        if (typeof record.command !== "string") throw new Error("command 必须是字符串");
        const checked = validateCommand(record.command);
        if (!checked.ok) throw new Error(checked.error);
        command = checked.value;
    }

    let launchMode = defaults.launchMode;
    if (record.launchMode !== undefined) {
        if (typeof record.launchMode !== "string" || !VALID_LAUNCH_MODES.has(record.launchMode as CommandLaunchMode)) {
            throw new Error("launchMode 必须是 auto、direct 或 zsh-rc");
        }
        launchMode = record.launchMode as CommandLaunchMode;
    }

    let model: string | undefined;
    if (record.model !== undefined && record.model !== null && record.model !== "") {
        if (typeof record.model !== "string") throw new Error("model 必须是字符串");
        const checked = validateModelSlug(record.model);
        if (!checked.ok) throw new Error(checked.error);
        model = checked.value;
    }

    let effort: AgyEffortLevel | undefined;
    if (record.effort !== undefined && record.effort !== null && record.effort !== "") {
        if (typeof record.effort !== "string") throw new Error("effort 必须是字符串");
        const checked = validateEffortLevel(record.effort);
        if (!checked.ok) throw new Error(checked.error);
        effort = checked.value;
    }

    let extraArgs = defaults.extraArgs;
    if (record.extraArgs !== undefined) {
        if (!Array.isArray(record.extraArgs) || record.extraArgs.some((item) => typeof item !== "string")) {
            throw new Error("extraArgs 必须是字符串数组");
        }
        extraArgs = [...record.extraArgs];
    }

    let syncSummaryToMainModel = defaults.syncSummaryToMainModel;
    if (record.syncSummaryToMainModel !== undefined) {
        if (typeof record.syncSummaryToMainModel !== "boolean") {
            throw new Error("syncSummaryToMainModel 必须是布尔值");
        }
        syncSummaryToMainModel = record.syncSummaryToMainModel;
    }

    return {
        command,
        launchMode,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        extraArgs,
        syncSummaryToMainModel,
    };
}

/** 扩展配置持久化存储，使用原子替换避免写入中途损坏配置文件。 */
export class ConfigStore {
    readonly filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    read(): AntigravityCliConfig {
        if (!existsSync(this.filePath)) {
            return cloneDefaultConfig();
        }
        const text = readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(text) as unknown;
        return normalizeConfig(parsed);
    }

    readSafe(): { config: AntigravityCliConfig; warning?: string } {
        try {
            return { config: this.read() };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return {
                config: cloneDefaultConfig(),
                warning: `配置文件读取失败，已回退默认配置（${detail}）`,
            };
        }
    }

    write(config: AntigravityCliConfig): AntigravityCliConfig {
        const normalized = normalizeConfig(config);
        const dir = dirname(this.filePath);
        mkdirSync(dir, { recursive: true });
        const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
        renameSync(tempPath, this.filePath);
        return normalized;
    }
}

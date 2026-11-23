# pi-extensions

[English](README.md) | 简体中文

Pi coding agent 的扩展集合（npm 包名 `pi-timer`），用一个仓库提供 Claude Code 风格的工具渲染、响应计时、状态栏定制、思考等级记忆、对话存档、多模型协作和会话回退。

没有构建步骤：Pi 直接加载 `.pi/extensions/` 下的 TypeScript 源码，改完执行 `/reload` 即生效。

## 扩展一览

| 入口 | 作用 | 交互方式 |
| --- | --- | --- |
| `.pi/extensions/claude-style/index.ts` | 接管 `read`、`bash`、`grep`、`find`、`ls`、`edit`、`write`（Windows 追加 `powershell`）的渲染，并提供 codemode 结果视图 | 自动生效 |
| `.pi/extensions/response-timer.ts` | 每轮对话计时：运行中显示 `⠼ Working...`，结束后写入 `Done: Xs` | 自动生效 |
| `.pi/extensions/custom-status-bar.ts` | 自定义 footer：模型与思考等级、上下文窗口、项目、Git 分支、Context 占用率、Pi home 与会话 ID | 自动生效 |
| `.pi/extensions/model-thinking-memory.ts` | 按模型记住上一次的 thinking level，新会话与 fork 时恢复上次模型与等级 | 自动生效 |
| `.pi/extensions/conversation-logger.ts` | 每轮把用户与助手文本保存为 Markdown | 自动生效 |
| `.pi/extensions/model-collaboration/index.ts` | 注册 `subagent` 工具做多模型协作，`/subagent-models` 配置子模型 | 工具调用 + 斜杠命令 |
| `.pi/extensions/rewind-claude/index.ts` | Claude Code Rewind 风格的代码/会话回退 | `/rewind-claude`、空输入连按两次 `Esc` |

除 `custom-status-bar` 外，其余扩展都带防重复注册逻辑，同一进程内被加载多次只会注册一次。

## 安装与启用

扩展依赖 Pi 运行环境提供的 `@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent`（见 `package.json` 的 `peerDependencies`），不需要单独安装。源码中的 `.ts` 由 Node.js 原生执行，开发验证环境为 Node.js 24.22.2。

### 项目内启用（推荐）

本仓库自身就是可运行的 Pi 项目。在仓库目录启动 Pi，项目受信任后会自动发现 `.pi/extensions/` 下的扩展：

1. 在仓库根目录启动 `pi`。
2. 首次进入时确认项目受信任。
3. 修改扩展后在会话内执行 `/reload`。

要在其他项目复用，把需要的文件或目录复制（或软链接）到该项目的 `.pi/extensions/`；单文件扩展是 `<name>.ts`，带多文件的扩展是 `<name>/index.ts`。

### 全局启用

放到 Pi 全局扩展目录，对所有项目生效：

```text
~/.pi/agent/extensions/<name>.ts
~/.pi/agent/extensions/<name>/index.ts
```

### 临时试用

```bash
pi -e ./.pi/extensions/response-timer.ts
```

`-e` 只加载单个扩展且不支持热重载，适合验证改动。

### 作为 Pi 包安装

`package.json` 的 `pi.extensions` 与 `.pi/extensions/` 下的实际入口一一对应，包方式安装与项目内自动加载启用同一组扩展：

```bash
pi install /path/to/pi-extensions
```

## 各扩展说明

### claude-style

复刻 Claude Code 的工具调用展示：工具标题、参数摘要、结果折叠与展开、错误配色。实现方式是包装 Pi 原生工具定义，只替换 `renderCall` / `renderResult`，执行逻辑与结果数据仍是原生实现。codemode 视图额外展示脚本摘要、嵌套调用、多模型调用成本合计，以及超宽内容与图片的降级表现。

### response-timer

用 `agent_start` / `agent_settled` 保证一轮只统计一次。运行中隐藏 Pi 内建的 Working 行，改为在编辑器顶部渲染计时行；完成后把耗时写入会话历史，可用于事后核对每轮真实耗时。

### custom-status-bar

通过 `ctx.ui.setFooter` 接管底栏，格式为：

```text
模型[等级] 128k · 项目 · 分支 · Context 42% used
pi-home:~/.pi/agent(session-id)
```

固定使用 ANSI 亮色与 Nerd Font 图标，不随 Pi 主题变化；宽内容会按终端宽度换行。

### model-thinking-memory

`thinking_level_select` 时落盘，`model_select` 与 `session_start` 时恢复。没有任何历史记录时完全交给 Pi 的默认值与能力 clamp，因此不会覆盖 Pi 自身策略。存储文件损坏会提示告警而不是中断会话。

### conversation-logger

只在 `turn_end` 且本轮不再调用工具（`stopReason !== "toolUse"`）时写入，内容仅包含纯文本，剔除思考、工具调用和内部注入标记。文件名为 `<YYYY-MM-DD-HHmmss>_<前 20 个字符>_<md5 前 6 位>.md`，用 `wx` 原子写入，同名时追加 `_2`、`_3` 后缀。

### model-collaboration

主模型通过 `subagent` 工具把任务交给另一个模型：

- `access: "read"` 只读评审与调研；`access: "write"` 可修改项目并执行命令，调用前必须经用户确认，且取消或失败不会回滚。
- 子模型使用主会话的认证信息，不复制也不持久化凭据。
- 结果超过 50KB 或 2000 行时截断，完整内容写入临时文件。
- 失败时保存脱敏诊断，便于定位是网络重试还是模型侧问题。

`/subagent-models` 打开配置面板，设置默认子模型和每个模型的思考等级。模型解析顺序为已有 thread 的模型 → 配置的默认模型 → 主会话模型；思考等级优先沿用 thread，其次按模型配置，最后回退到 scoped 配置或模型支持的默认等级。

### rewind-claude

`/rewind-claude` 或空输入连按两次 `Esc`（输入框非空时双击 `Esc` 会保存并清空草稿，之后按 `↑` 恢复）。支持从任意历史 prompt 创建检查点，动作包括：

- Restore code and conversation
- Restore conversation
- Restore code
- Summarize from here / Summarize up to here
- Never mind

检查点只追踪 Pi 的 `edit` 和 `write` 工具，不覆盖 Bash、外部编辑器、符号链接或硬链接的改动。会话恢复会创建真正的 Pi Fork Session，并继承 Fork 前的模型与 thinking level。细节见 [.pi/extensions/rewind-claude/README.md](.pi/extensions/rewind-claude/README.md)。

## 数据与配置位置

| 数据 | 位置 | 产出者 |
| --- | --- | --- |
| 对话日志 | `<项目>/.pi/logs/` | conversation-logger |
| 模型思考等级记忆 | `<Pi agent 目录>/model-thinking-levels.json` | model-thinking-memory |
| 子模型配置 | `<Pi agent 目录>/subagent-models.json` | model-collaboration |
| 协作诊断日志 | `<Pi agent 目录>/model-collaboration-diagnostics/<sessionId>.jsonl` | model-collaboration |
| Rewind 检查点 | `<会话文件>.rewind-claude/`（`manifest.json` + `blobs/`，最多 100 个检查点）；无会话文件时落在临时目录 | rewind-claude |

`<Pi agent 目录>` 即 `getAgentDir()` 的返回值，默认 `~/.pi/agent`。

## 目录结构

```text
.
├── .pi/extensions/           # 扩展源码，Pi 直接加载
│   ├── *.ts                  # 单文件扩展：计时、日志、状态栏、思考等级记忆
│   ├── claude-style/         # Claude Code 风格工具渲染与 codemode 视图
│   ├── model-collaboration/  # subagent 工具、配置面板、进度与诊断
│   └── rewind-claude/        # /rewind-claude 命令、检查点存储与交互
├── tests/                    # 顶层扩展的行为测试
├── docs/                     # 设计稿与模块文档
├── package.json              # Pi 包清单与脚本
└── tsconfig.json             # 严格模式类型检查配置
```

## 开发

```bash
npm test                            # 顶层测试 + Rewind 测试
npm run typecheck                   # 严格类型检查（需本地可用的 tsc）
cd .pi/extensions/rewind-claude && npm test   # 只跑 Rewind 测试
```

`typescript` 与 `@types/node` 已声明为 `devDependencies`，`npm install` 后即可直接执行 `npm run typecheck`。

约定：

- 四个空格缩进、双引号、分号，ESM 导入显式带 `.ts` 后缀。
- 测试使用 Node 内置 `node:test` 与 `node:assert/strict`，文件名 `*.test.ts`。
- 顶层通用行为测试放 `tests/`，特性内部测试与实现同目录（`rewind-claude`）。
- 涉及文件或 TUI 的行为，用临时目录断言渲染输出或落盘结果，不断言实现细节。

## 已知限制

- **Summarize up to here 的边界**：会话短到 Pi 返回 `Nothing to compact (session too small)` 时，`session_before_compact` 不会触发，该动作会报错且不修改会话。
- **与旧扩展共存**：若同时启用 `@ayulab/pi-rewind`，会话恢复时旧扩展仍会弹出 `Sync files?`；需要单一 Claude Code 风格交互时，在 Pi `packages` 配置中停用它。

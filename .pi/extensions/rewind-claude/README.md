# Rewind Claude

项目级 Pi 扩展，复刻 Claude Code 的 Rewind 工作流。

## 使用

```text
/rewind-claude
```

也可以在输入框为空时连续按两次 `Esc`。输入框非空时双击 `Esc` 会保存并清空草稿，随后可按 `↑` 恢复。

首次加入项目后执行：

```text
/reload
```

## 支持动作

- Restore code and conversation
- Restore conversation
- Restore code
- Summarize from here
- Summarize up to here
- Never mind

point 列表最多显示七项，并让当前选中项保持在可视窗口中。列表中的文件增删统计仅表示该 Prompt 后 `edit`、`write` 工具产生的变化；确认页统计表示从当前工作区恢复到目标 point 的累计变化。

确认页按 `Esc` 或选择 `Never mind` 会返回 point 列表；point 列表按 `Esc` 才会关闭 Rewind。

恢复会话时会创建真正的 Pi Fork Session。Fork 后继续使用 Rewind 前的当前模型和 thinking level。新 Session 生成独立 Manifest，仅继承目标 point 之前的检查点；不可变 blob 优先通过硬链接共享，跨文件系统时复制兜底。

代码检查点仅追踪 Pi `edit`、`write` 工具，不追踪 Bash、外部编辑器、符号链接或硬链接。

## 测试

```bash
cd .pi/extensions/rewind-claude
npm test
```

## 当前 Pi 限制

`Summarize up to here` 通过 `session_before_compact` 提供指定边界的 Compaction。若会话短到 Pi 返回 `Nothing to compact (session too small)`，当前公开扩展 Interface 不会触发该 Hook，因此该动作会显示错误且不修改会话。

本机若同时启用旧的 `@ayulab/pi-rewind`，会话恢复时旧扩展还会弹出 `Sync files?`。要获得单一 Claude Code 风格交互，请在 Pi `packages` 配置中停用旧扩展后执行 `/reload`。

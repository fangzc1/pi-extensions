/**
 * 自定义状态栏扩展 - 带 Nerd Font 图标
 * 格式:
 *  模型[级别] 上下文窗口 · 󰉋 项目 · 󰊢 分支 · Context 占用百分比
 * pi-home:Pi home 目录(会话 ID)
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { basename } from "node:path";

// Nerd Font 图标
const ICONS = {
  model: "\u{E26D}",     //  AI
  project: "\u{F024B}",  // 󰉋 folder-outline
  branch: "\u{F02A2}",   // 󰊢 source-branch
} as const;

const ANSI_RESET = "\x1b[0m";
const GPT_5_MAX_CONTEXT_WINDOW = 1_050_000;
const GPT_5_LARGE_CONTEXT_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

/** 使用与 ccline c16 配置一致的固定亮色及粗体，不受 Pi 主题影响。 */
function ansiBright(code: 92 | 93 | 94 | 95 | 96, text: string): string {
  return `\x1b[1;${code}m${text}${ANSI_RESET}`;
}

/**
 * 状态栏展示模型的最大上下文能力，与 DeepSeek、GLM 等模型保持同一口径。
 * 部分 Provider 目录可能返回较小的端点有效窗口，但这些模型的最大窗口为 1.05M。
 */
function getEffectiveContextWindow(model: {
  id?: string;
  provider?: string;
  contextWindow?: number;
} | undefined): number | undefined {
  if (model?.id !== undefined && GPT_5_LARGE_CONTEXT_MODELS.has(model.id)) {
    return GPT_5_MAX_CONTEXT_WINDOW;
  }
  return model?.contextWindow;
}

/** 格式化上下文窗口大小 */
function fmtContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return `${n}`;
}

export default function (pi: ExtensionAPI) {
  let tuiRef: { requestRender: () => void } | null = null;

  // 事件监听: 刷新渲染
  function requestRender(): void {
    tuiRef?.requestRender();
  }

  pi.on("model_select", requestRender);
  pi.on("thinking_level_select", requestRender);

  pi.on("turn_end", () => {
    requestRender();
  });

  pi.on("session_start", (_event, ctx) => {
    const projectName = basename(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();

    ctx.ui.setFooter((tui, theme, footerData) => {
      tuiRef = tui;
      const unsubBranch = footerData.onBranchChange(() => {
        tui.requestRender();
      });

      return {
        dispose: () => {
          unsubBranch();
          tuiRef = null;
        },
        invalidate() {},
        render(width: number): string[] {
          const model = ctx.model;
          const modelId = model?.id || "no-model";
          const thinking = ctx.thinkingLevel ?? "off";
          const contextWindow = getEffectiveContextWindow(model);
          const branch = footerData.getGitBranch() || "no-branch";

          // Pi 会正确处理压缩后的上下文，并估算尚未计入 usage 的尾部消息。
          // 使用 token 数和最大窗口重新计算，确保窗口大小与占用率采用同一口径。
          const contextUsage = ctx.getContextUsage();
          const contextPercent = contextUsage?.tokens !== null
            && contextUsage?.tokens !== undefined
            && contextWindow
            ? (contextUsage.tokens / contextWindow) * 100
            : contextUsage?.percent;
          const contextDisplay = contextPercent === null || contextPercent === undefined
            ? "Context ? used"
            : `Context ${Math.round(contextPercent)}% used`;

          // ---- 固定颜色：精确对应 ccline 的 ANSI 16 色配置 ----
          const cyan = (text: string) => ansiBright(96, text);    // c16=14
          const yellow = (text: string) => ansiBright(93, text);  // c16=11
          const green = (text: string) => ansiBright(92, text);   // c16=10
          const blue = (text: string) => ansiBright(94, text);    // c16=12
          const purple = (text: string) => ansiBright(95, text);  // c16=13
          // 分隔点使用主题的 dim 色，而不是 ANSI faint（即 \x1b[2;37m）：
          // faint 的渲染方式由终端自行决定，深色主题下部分终端会把它渲染成
          // 半透明叠加，视觉上表现为与终端背景不一致的色块。
          // 主题色是确定的实色前景，且 theme.fg 只重置前景（\x1b[39m），
          // 不会触碰背景色。
          const sep = theme.fg("dim", " · ");

          const parts: string[] = [
            // ccline model: 图标、名称、思考级别及上下文均为亮青色粗体
            cyan(
              `${ICONS.model} ${modelId}[${thinking}]${contextWindow ? ` ${fmtContext(contextWindow)}` : ""}`,
            ),
            // ccline directory: 亮黄色图标 + 亮绿色名称
            yellow(ICONS.project) + " " + green(projectName),
            // ccline git: 亮蓝色图标与名称，不显示状态圆点
            blue(`${ICONS.branch} ${branch}`),
            // ccline context_window: 仅显示当前上下文占用百分比
            purple(contextDisplay),
          ];

          const lines: string[] = wrapTextWithAnsi(parts.join(sep), width);
          // Pi home 和会话 ID 属于次要元数据，固定另起一行并跟随终端宽度完整换行。
          const sessionMetadata = theme.fg(
            "dim",
            `pi-home:${getAgentDir()}(${sessionId})`,
          );
          lines.push(...wrapTextWithAnsi(sessionMetadata, width));

          // 后续行: 其他扩展状态(multimodal-proxy、LSP 等)
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const statusParts: string[] = [];
            for (const [, text] of statuses) {
              if (text) statusParts.push(text);
            }
            if (statusParts.length > 0) {
              lines.push(...wrapTextWithAnsi(statusParts.join(" "), width));
            }
          }

          return lines;
        },
      };
    });
  });

  pi.on("session_shutdown", () => {
    tuiRef = null;
  });
}

import type { Theme, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { ClaudeCodemodeView, type CodemodeResult } from "./codemode-view.ts";
import { resolveExpandHint } from "./format-utils.ts";

/** Pi 内置 codemode 工具名（`CODEMODE_TOOL_NAME` 未从包入口导出）。 */
const CODEMODE_TOOL_NAME = "codemode";

interface CodemodeRenderState {
    view?: ClaudeCodemodeView;
    resultComponent?: Container;
}

function getView(
    theme: Theme,
    context: { state: unknown; lastComponent?: unknown; args: unknown },
): ClaudeCodemodeView {
    const state = context.state as CodemodeRenderState;
    const view =
        context.lastComponent instanceof ClaudeCodemodeView
            ? context.lastComponent
            : state.view ?? new ClaudeCodemodeView(context.args, theme);
    state.view = view;
    return view;
}

/**
 * 只替换 codemode 的展示层：Pi 内置 codemode 的工具定义未导出，无法像内置工具那样重新注册，
 * 因此改用 `pi.registerToolRenderer` 提供 Claude Code 外观，执行语义完全由 Pi 原生实现保留。
 */
const claudeCodemodeRenderers: ToolRenderers = {
    renderShell: "self",
    renderCall(args, theme, context) {
        const view = getView(theme, context);
        view.setArgs(args);
        view.setTheme(theme);
        view.setShowImages(context.showImages);
        view.setExpanded(context.expanded);
        view.setExpandHint(resolveExpandHint(context));
        return view;
    },
    renderResult(result, options, theme, context) {
        const view = getView(theme, context);
        const codemodeResult = result as CodemodeResult;
        view.setTheme(theme);
        view.setShowImages(context.showImages);
        view.setExpandHint(resolveExpandHint(context));
        if (options.isPartial) {
            view.setPending(codemodeResult, options.expanded);
        } else {
            view.setResult(codemodeResult, context.isError ? "error" : "success", options.expanded);
        }

        // 结果已更新到 renderCall 返回的同一组件，避免 self shell 重复输出。
        const state = context.state as CodemodeRenderState;
        state.resultComponent ??= new Container();
        return state.resultComponent;
    },
};

/** 为名为 codemode 的工具选择 Claude 风格渲染器，其余工具沿用 Pi 默认解析结果。 */
export function createClaudeCodemodeToolRenderer(): ToolRendererResolver {
    return (toolName, next) => (toolName === CODEMODE_TOOL_NAME ? claudeCodemodeRenderers : next());
}

import type { Theme, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import {
    ClaudeExternalToolView,
    type ClaudeExternalToolKind,
    type ExternalToolResult,
} from "./external-view.ts";
import { resolveExpandHint } from "./format-utils.ts";

const TOOL_SEARCH_TOOL_NAME = "tool_search";
const MCP_RESOURCE_TOOL_NAMES = new Set([
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
]);

interface ExternalRenderState {
    view?: ClaudeExternalToolView;
    resultComponent?: Container;
}

/** 与 Pi 内部 `isMcpToolName` 一致：匹配 `mcp__*` 以及三个内置 MCP 资源工具。 */
export function isMcpToolName(toolName: string): boolean {
    return toolName.startsWith("mcp__") || MCP_RESOURCE_TOOL_NAMES.has(toolName);
}

function resolveExternalKind(toolName: string): ClaudeExternalToolKind | undefined {
    if (toolName === TOOL_SEARCH_TOOL_NAME) return "tool_search";
    if (isMcpToolName(toolName)) return "mcp";
    return undefined;
}

function createRenderers(kind: ClaudeExternalToolKind, toolName: string): ToolRenderers {
    return {
        renderShell: "self",
        renderCall(args, theme: Theme, context) {
            const state = context.state as ExternalRenderState;
            const view =
                context.lastComponent instanceof ClaudeExternalToolView
                    ? context.lastComponent
                    : state.view ?? new ClaudeExternalToolView(kind, toolName, args, theme);
            view.setArgs(args);
            view.setTheme(theme);
            view.setShowImages(context.showImages);
            view.setExpanded(context.expanded);
            view.setExpandHint(resolveExpandHint(context));
            state.view = view;
            return view;
        },
        renderResult(result, options, theme: Theme, context) {
            const state = context.state as ExternalRenderState;
            const view =
                state.view ?? new ClaudeExternalToolView(kind, toolName, context.args, theme);
            const externalResult = result as ExternalToolResult;
            view.setTheme(theme);
            view.setShowImages(context.showImages);
            view.setExpandHint(resolveExpandHint(context));
            if (options.isPartial) {
                view.setPending(externalResult, options.expanded);
            } else {
                view.setResult(externalResult, context.isError ? "error" : "success", options.expanded);
            }
            state.view = view;

            // 结果已写入 renderCall 的同一组件，空容器防止 self shell 重复输出。
            state.resultComponent ??= new Container();
            return state.resultComponent;
        },
    };
}

/** 统一收口 tool_search 与 MCP 工具为无边框 Claude 风格，其余工具交回 `next()`。 */
export function createClaudeExternalToolRenderer(): ToolRendererResolver {
    const cache = new Map<string, ToolRenderers>();
    return (toolName, next) => {
        const kind = resolveExternalKind(toolName);
        if (!kind) return next();
        let renderers = cache.get(toolName);
        if (!renderers) {
            renderers = createRenderers(kind, toolName);
            cache.set(toolName, renderers);
        }
        return renderers;
    };
}

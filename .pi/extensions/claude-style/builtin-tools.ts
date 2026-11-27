import {
    createBashToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createPowerShellToolDefinition,
    createReadToolDefinition,
    type Theme,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { resolveExpandHint } from "./format-utils.ts";
import { ClaudeBuiltinToolView, type ClaudeBuiltinToolKind } from "./tool-view.ts";

type Platform = NodeJS.Platform;
type AnyToolDefinition = ToolDefinition<any, any, any>;

interface ClaudeRenderState {
    view?: ClaudeBuiltinToolView;
    resultComponent?: Container;
}

function createClaudeToolDefinition(
    original: AnyToolDefinition,
    kind: ClaudeBuiltinToolKind,
): AnyToolDefinition {
    return {
        ...original,
        renderShell: "self" as const,
        renderCall(args: unknown, theme: Theme, context) {
            const state = context.state as ClaudeRenderState;
            const view =
                context.lastComponent instanceof ClaudeBuiltinToolView
                    ? context.lastComponent
                    : state.view ?? new ClaudeBuiltinToolView(kind, args, theme);
            view.setArgs(args);
            view.setTheme(theme);
            view.setCwd(context.cwd);
            view.setExpanded(context.expanded);
            view.setExpandHint(resolveExpandHint(context));
            state.view = view;
            return view;
        },
        renderResult(
            result,
            options,
            theme: Theme,
            context,
        ) {
            const state = context.state as ClaudeRenderState;
            const view = state.view ?? new ClaudeBuiltinToolView(kind, context.args, theme);
            view.setTheme(theme);
            view.setCwd(context.cwd);
            view.setExpandHint(resolveExpandHint(context));
            if (options.isPartial) {
                view.setPending(result, options.expanded);
            } else {
                view.setResult(result, context.isError ? "error" : "success", options.expanded);
            }
            state.view = view;

            // 结果已更新到 renderCall 返回的同一组件，避免 self shell 重复输出。
            state.resultComponent ??= new Container();
            return state.resultComponent;
        },
    };
}

/** 创建保留 Pi 原生执行语义、仅统一 Claude Code 外观的内置工具定义。 */
export function createClaudeBuiltinToolDefinitions(
    cwd: string,
    platform: Platform = process.platform,
): AnyToolDefinition[] {
    const definitions: AnyToolDefinition[] = [
        createClaudeToolDefinition(createReadToolDefinition(cwd), "read"),
        createClaudeToolDefinition(createBashToolDefinition(cwd), "bash"),
    ];
    if (platform === "win32") {
        definitions.push(
            createClaudeToolDefinition(createPowerShellToolDefinition(cwd), "powershell"),
        );
    }
    definitions.push(
        createClaudeToolDefinition(createGrepToolDefinition(cwd), "grep"),
        createClaudeToolDefinition(createFindToolDefinition(cwd), "find"),
        createClaudeToolDefinition(createLsToolDefinition(cwd), "ls"),
    );
    return definitions;
}

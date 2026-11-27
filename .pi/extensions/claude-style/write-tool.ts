import {
    createWriteToolDefinition,
    type Theme,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";

import { resolveExpandHint, type ExpandHintSource } from "./format-utils.ts";
import { ClaudeWriteView, createWriteViewModel, type WriteViewModel } from "./write-view.ts";

interface WriteRenderState {
    view?: ClaudeWriteView;
    resultModel?: WriteViewModel;
    resultComponent?: Container;
}

/** Pi 未公开 ToolRenderContext，扩展只声明实际使用的最小结构。 */
interface WriteRenderContext extends Partial<ExpandHintSource> {
    args: unknown;
    state: unknown;
    expanded: boolean;
    lastComponent?: Component;
    isError: boolean;
    cwd?: string;
}

function getArgs(args: unknown): { path: string; content: string } {
    if (typeof args !== "object" || args === null) return { path: "unknown", content: "" };
    const input = args as { path?: unknown; file_path?: unknown; content?: unknown };
    const rawPath = input.path ?? input.file_path;
    return {
        path: typeof rawPath === "string" && rawPath.length > 0 ? rawPath : "unknown",
        content: typeof input.content === "string" ? input.content : "",
    };
}

function getErrorText(result: { content: Array<{ type: string; text?: string }> }): string {
    return (
        result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text ?? "")
            .filter(Boolean)
            .join("\n") || "Write failed"
    );
}

function getState(context: WriteRenderContext): WriteRenderState {
    return context.state as WriteRenderState;
}

function resolveHintFromContext(context: WriteRenderContext): string {
    if (typeof context.keyText === "function" && typeof context.keyHint === "function") {
        return resolveExpandHint({ keyText: context.keyText, keyHint: context.keyHint });
    }
    return resolveExpandHint();
}

function updateView(
    state: WriteRenderState,
    model: WriteViewModel,
    theme: Theme,
    expanded: boolean,
    expandHint: string,
    lastComponent: Component | undefined,
): ClaudeWriteView {
    const view =
        lastComponent instanceof ClaudeWriteView
            ? lastComponent
            : state.view ?? new ClaudeWriteView(model, theme);
    view.setTheme(theme);
    view.setModel(model);
    view.setExpanded(expanded);
    view.setExpandHint(expandHint);
    state.view = view;
    return view;
}

/** 创建保持 Pi 原生 write 执行语义、仅替换 TUI renderer 的工具定义。 */
export function createClaudeWriteToolDefinition(cwd: string) {
    const original = createWriteToolDefinition(cwd);

    return {
        ...original,
        renderShell: "self" as const,
        renderCall(args: WriteToolInput, theme: Theme, context: WriteRenderContext) {
            const state = getState(context);
            const input = getArgs(args);
            const model =
                state.resultModel ??
                createWriteViewModel(input.path, input.content, "preview", undefined, context.cwd ?? cwd);
            return updateView(
                state,
                model,
                theme,
                context.expanded,
                resolveHintFromContext(context),
                context.lastComponent,
            );
        },
        renderResult(
            result: { content: Array<{ type: string; text?: string }> },
            options: { expanded: boolean; isPartial: boolean },
            theme: Theme,
            context: WriteRenderContext,
        ) {
            const state = getState(context);
            const expandHint = resolveHintFromContext(context);
            if (!options.isPartial) {
                const input = getArgs(context.args);
                state.resultModel = context.isError
                    ? createWriteViewModel(
                          input.path,
                          input.content,
                          "error",
                          getErrorText(result),
                          context.cwd ?? cwd,
                      )
                    : createWriteViewModel(
                          input.path,
                          input.content,
                          "success",
                          undefined,
                          context.cwd ?? cwd,
                      );
            }
            if (state.view) {
                state.view.setTheme(theme);
                if (state.resultModel) state.view.setModel(state.resultModel);
                state.view.setExpanded(options.expanded);
                state.view.setExpandHint(expandHint);
            }

            // Write 正文始终由 renderCall 的同一组件承载，避免完成时重复输出。
            state.resultComponent ??= new Container();
            return state.resultComponent;
        },
    };
}

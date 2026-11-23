import {
    createEditToolDefinition,
    type EditToolDetails,
    type EditToolInput,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";

import {
    ClaudeEditView,
    createClaudeEditModel,
    createClaudeEditPreview,
    type ClaudeEditModel,
} from "./edit-view.ts";

interface EditRenderState {
    view?: ClaudeEditView;
    resultModel?: ClaudeEditModel;
    resultComponent?: Container;
}

/** Pi 未公开 ToolRenderContext，扩展只声明 renderer 实际使用的结构。 */
interface EditRenderContext {
    args: unknown;
    state: unknown;
    lastComponent?: Component;
    isError: boolean;
    cwd: string;
}

function getInput(args: unknown): {
    path: string;
    edits: Array<{ oldText: string; newText: string }>;
} {
    if (typeof args !== "object" || args === null) return { path: "unknown", edits: [] };
    const input = args as { path?: unknown; file_path?: unknown; edits?: unknown };
    const rawPath = input.path ?? input.file_path;
    const edits = Array.isArray(input.edits)
        ? input.edits.filter(
              (edit): edit is { oldText: string; newText: string } =>
                  typeof edit === "object" &&
                  edit !== null &&
                  typeof (edit as { oldText?: unknown }).oldText === "string" &&
                  typeof (edit as { newText?: unknown }).newText === "string",
          )
        : [];
    return {
        path: typeof rawPath === "string" && rawPath.length > 0 ? rawPath : "unknown",
        edits,
    };
}

function getErrorText(result: { content: Array<{ type: string; text?: string }> }): string {
    return (
        result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text ?? "")
            .filter(Boolean)
            .join("\n") || "Edit failed"
    );
}

function getState(context: EditRenderContext): EditRenderState {
    return context.state as EditRenderState;
}

function updateView(
    state: EditRenderState,
    model: ClaudeEditModel,
    theme: Theme,
    lastComponent: Component | undefined,
): ClaudeEditView {
    const view =
        lastComponent instanceof ClaudeEditView
            ? lastComponent
            : state.view ?? new ClaudeEditView(model, theme);
    view.setTheme(theme);
    view.setModel(model);
    state.view = view;
    return view;
}

/** 创建保持 Pi 原生 edit 执行语义、仅替换为 Claude unified renderer 的工具定义。 */
export function createClaudeEditToolDefinition(cwd: string) {
    const original = createEditToolDefinition(cwd);

    return {
        ...original,
        renderShell: "self" as const,
        renderCall(args: EditToolInput, theme: Theme, context: EditRenderContext) {
            const state = getState(context);
            const input = getInput(args);
            const model =
                state.resultModel ?? createClaudeEditPreview(input.path, input.edits, context.cwd);
            return updateView(state, model, theme, context.lastComponent);
        },
        renderResult(
            result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails },
            options: { expanded: boolean; isPartial: boolean },
            theme: Theme,
            context: EditRenderContext,
        ) {
            const state = getState(context);
            if (!options.isPartial) {
                const input = getInput(context.args);
                state.resultModel = context.isError
                    ? createClaudeEditModel(
                          input.path,
                          "",
                          context.cwd,
                          "error",
                          getErrorText(result),
                      )
                    : createClaudeEditModel(
                          input.path,
                          result.details?.diff ?? "",
                          context.cwd,
                          "success",
                      );
                if (state.view) {
                    state.view.setTheme(theme);
                    state.view.setModel(state.resultModel);
                }
            }

            // 主体由 renderCall 的同一组件承载，避免完成时重复输出。
            state.resultComponent ??= new Container();
            return state.resultComponent;
        },
    };
}

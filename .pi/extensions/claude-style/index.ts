import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createClaudeBuiltinToolDefinitions } from "./builtin-tools.ts";
import { createClaudeCodemodeToolRenderer } from "./codemode-tool.ts";
import { createClaudeEditToolDefinition } from "./edit-tool.ts";
import { createClaudeExternalToolRenderer } from "./external-tool.ts";
import { createClaudeWriteToolDefinition } from "./write-tool.ts";

export { createClaudeBuiltinToolDefinitions } from "./builtin-tools.ts";
export { createClaudeCodemodeToolRenderer } from "./codemode-tool.ts";
export { ClaudeCodemodeView, type CodemodeResult } from "./codemode-view.ts";
export { createClaudeEditToolDefinition } from "./edit-tool.ts";
export { createClaudeExternalToolRenderer, isMcpToolName } from "./external-tool.ts";
export {
    ClaudeExternalToolView,
    formatMcpToolTitle,
    type ExternalToolResult,
} from "./external-view.ts";
export { createClaudeWriteToolDefinition } from "./write-tool.ts";

const runtimeState = globalThis as typeof globalThis & {
    __piTimerClaudeStyleOwner?: symbol;
};

function acquireRegistration(): (() => void) | undefined {
    if (runtimeState.__piTimerClaudeStyleOwner) return undefined;
    const owner = Symbol("pi-timer:claude-style");
    runtimeState.__piTimerClaudeStyleOwner = owner;
    return () => {
        if (runtimeState.__piTimerClaudeStyleOwner === owner) {
            runtimeState.__piTimerClaudeStyleOwner = undefined;
        }
    };
}

/** 单一 Claude Code 风格入口：统一注册内置工具与外部高噪音工具的高信噪比渲染器。 */
export default function claudeStyle(pi: ExtensionAPI): void {
    const releaseRegistration = acquireRegistration();
    if (!releaseRegistration) return;

    pi.on("session_shutdown", async () => releaseRegistration());

    const cwd = process.cwd();
    for (const tool of createClaudeBuiltinToolDefinitions(cwd)) {
        pi.registerTool(tool);
    }
    pi.registerTool(createClaudeEditToolDefinition(cwd));
    pi.registerTool(createClaudeWriteToolDefinition(cwd));
    pi.registerToolRenderer(createClaudeCodemodeToolRenderer());
    pi.registerToolRenderer(createClaudeExternalToolRenderer());
}

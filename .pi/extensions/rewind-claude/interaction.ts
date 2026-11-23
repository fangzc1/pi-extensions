export type RewindAction =
    | "restore-both"
    | "restore-conversation"
    | "restore-code"
    | "summarize-from"
    | "summarize-up-to"
    | "never-mind";

export function shouldForkConversation(action: RewindAction): boolean {
    return action === "restore-both" || action === "restore-conversation";
}

export interface ActionOption {
    value: RewindAction;
    label: string;
    description: string;
    acceptsContext?: boolean;
}

const RESTORE_CONVERSATION: ActionOption = {
    value: "restore-conversation",
    label: "Restore conversation",
    description: "The conversation will be forked.",
};
const SUMMARIZE_FROM: ActionOption = {
    value: "summarize-from",
    label: "Summarize from here",
    description: "Messages after this point will be summarized.",
    acceptsContext: true,
};
const SUMMARIZE_UP_TO: ActionOption = {
    value: "summarize-up-to",
    label: "Summarize up to here",
    description: "Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.",
    acceptsContext: true,
};
const NEVER_MIND: ActionOption = {
    value: "never-mind",
    label: "Never mind",
    description: "The conversation will be unchanged.",
};
export function buildActionOptions(hasChanges: boolean): ActionOption[] {
    if (!hasChanges) {
        return [RESTORE_CONVERSATION, SUMMARIZE_FROM, SUMMARIZE_UP_TO, NEVER_MIND];
    }
    return [
        {
            value: "restore-both",
            label: "Restore code and conversation",
            description: "The conversation will be forked.",
        },
        RESTORE_CONVERSATION,
        {
            value: "restore-code",
            label: "Restore code",
            description: "The conversation will be unchanged.",
        },
        SUMMARIZE_FROM,
        SUMMARIZE_UP_TO,
        NEVER_MIND,
    ];
}

export async function chooseRewindAction<TPoint, TAction extends { value: string }>(
    pickPoint: () => Promise<TPoint | null>,
    pickAction: (point: TPoint) => Promise<TAction | null>,
): Promise<{ point: TPoint; action: TAction } | null> {
    while (true) {
        const point = await pickPoint();
        if (!point) return null;
        const action = await pickAction(point);
        // Claude Code 中确认页 Esc 与 Never mind 都返回 point 列表。
        if (!action || action.value === "never-mind") continue;
        return { point, action };
    }
}

export function selectActiveCheckpoints<T extends { userEntryId: string }>(
    checkpoints: T[],
    branchEntries: Array<{ id: string }>,
): T[] {
    const activeEntryIds = new Set(branchEntries.map((entry) => entry.id));
    return checkpoints.filter((checkpoint) => activeEntryIds.has(checkpoint.userEntryId));
}

/** 根据 entry ID 重建目标消息之前的输入历史，返回顺序与 Editor 内部历史一致。 */
export function buildPromptHistoryBefore(
    entries: Array<{ id: string }>,
    targetEntryId: string,
): string[] {
    const targetIndex = entries.findIndex((entry) => entry.id === targetEntryId);
    if (targetIndex < 0) throw new Error("The selected rewind point is not on the active branch");

    const history: string[] = [];
    for (let index = targetIndex - 1; index >= 0 && history.length < 100; index--) {
        const entry = entries[index] as { message?: unknown };
        const text = getUserPromptText(entry.message).trim();
        if (!text || history.at(-1) === text) continue;
        history.push(text);
    }
    return history;
}

export function findUserEntryForMessage(
    entries: unknown[],
    message: unknown,
): { id: string; message: unknown } | undefined {
    const targetText = getUserPromptText(message);
    const targetTimestamp =
        message && typeof message === "object"
            ? (message as { timestamp?: unknown }).timestamp
            : undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as { type?: unknown; id?: unknown; message?: unknown };
        if (candidate.type !== "message" || typeof candidate.id !== "string") continue;
        if (getUserPromptText(candidate.message) !== targetText) continue;
        const candidateTimestamp =
            candidate.message && typeof candidate.message === "object"
                ? (candidate.message as { timestamp?: unknown }).timestamp
                : undefined;
        if (targetTimestamp !== undefined && candidateTimestamp !== targetTimestamp) continue;
        return { id: candidate.id, message: candidate.message };
    }
    return undefined;
}

export function getUserPromptText(message: unknown): string {
    if (!message || typeof message !== "object") return "";
    const candidate = message as { role?: unknown; content?: unknown };
    if (candidate.role !== "user") return "";
    if (typeof candidate.content === "string") return candidate.content;
    if (!Array.isArray(candidate.content)) return "";
    return candidate.content
        .filter(
            (item): item is { type: "text"; text: string } =>
                typeof item === "object" &&
                item !== null &&
                (item as { type?: unknown }).type === "text" &&
                typeof (item as { text?: unknown }).text === "string",
        )
        .map((item) => item.text)
        .join("\n");
}

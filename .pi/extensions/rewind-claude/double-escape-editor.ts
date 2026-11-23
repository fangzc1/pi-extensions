import type { AutocompleteProvider, EditorComponent } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

import { DoubleEscapeDetector } from "./core.ts";

type AppAwareEditor = EditorComponent & {
    actionHandlers?: Map<string, () => void>;
    onEscape?: () => void;
    onCtrlD?: () => void;
    onPasteImage?: () => void;
    onExtensionShortcut?: (data: string) => boolean | void;
};

/** 在任意现有 Editor 外增加双 Esc 行为，其他输入及应用级 handler 全部转发。 */
export class DoubleEscapeEditor implements EditorComponent {
    onSubmit?: (text: string) => void;
    onChange?: (text: string) => void;
    readonly actionHandlers: Map<string, () => void>;
    private readonly base: EditorComponent;
    private readonly appBase: AppAwareEditor;
    private readonly detector = new DoubleEscapeDetector(500);
    private readonly isIdle: () => boolean;
    private readonly openRewind: () => void;
    private readonly promptHistory?: string[];

    constructor(
        base: EditorComponent,
        options: { isIdle: () => boolean; openRewind: () => void; promptHistory?: string[] },
    ) {
        this.base = base;
        this.appBase = base as AppAwareEditor;
        this.actionHandlers = this.appBase.actionHandlers ?? new Map<string, () => void>();
        this.isIdle = options.isIdle;
        this.openRewind = options.openRewind;
        this.promptHistory = options.promptHistory;
        this.base.onSubmit = (text) => this.onSubmit?.(text);
        this.base.onChange = (text) => this.onChange?.(text);

        // Pi 在 fork 时会销毁自定义 Editor；按旧到新顺序回灌，保持上键从最新输入开始。
        const history = this.promptHistory ?? [];
        for (let index = history.length - 1; index >= 0; index--) {
            this.base.addToHistory?.(history[index]!);
        }
    }

    get onEscape(): (() => void) | undefined {
        return this.appBase.onEscape;
    }

    set onEscape(handler: (() => void) | undefined) {
        this.appBase.onEscape = handler;
    }

    get onCtrlD(): (() => void) | undefined {
        return this.appBase.onCtrlD;
    }

    set onCtrlD(handler: (() => void) | undefined) {
        this.appBase.onCtrlD = handler;
    }

    get onPasteImage(): (() => void) | undefined {
        return this.appBase.onPasteImage;
    }

    set onPasteImage(handler: (() => void) | undefined) {
        this.appBase.onPasteImage = handler;
    }

    get onExtensionShortcut(): ((data: string) => boolean | void) | undefined {
        return this.appBase.onExtensionShortcut;
    }

    set onExtensionShortcut(handler: ((data: string) => boolean | void) | undefined) {
        this.appBase.onExtensionShortcut = handler;
    }

    get focused(): boolean {
        return (this.base as EditorComponent & { focused?: boolean }).focused ?? false;
    }

    set focused(value: boolean) {
        const target = this.base as EditorComponent & { focused?: boolean };
        if ("focused" in target) target.focused = value;
    }

    get wantsKeyRelease(): boolean {
        return this.base.wantsKeyRelease ?? false;
    }

    get borderColor(): ((text: string) => string) | undefined {
        return this.base.borderColor;
    }

    set borderColor(value: ((text: string) => string) | undefined) {
        this.base.borderColor = value;
    }

    render(width: number): string[] {
        return this.base.render(width);
    }

    invalidate(): void {
        this.base.invalidate();
    }

    handleInput(data: string): void {
        if (!matchesKey(data, "escape")) {
            this.detector.reset();
            this.base.handleInput(data);
            return;
        }

        const text = this.base.getExpandedText?.() ?? this.base.getText();
        const action = this.detector.press(Date.now(), text, this.isIdle());
        if (action === "save-draft") {
            this.addToHistory(text);
            this.base.setText("");
            return;
        }
        if (action === "open-rewind") {
            this.openRewind();
            return;
        }
        this.base.handleInput(data);
    }

    getText(): string {
        return this.base.getText();
    }

    getExpandedText(): string {
        return this.base.getExpandedText?.() ?? this.base.getText();
    }

    setText(text: string): void {
        this.base.setText(text);
    }

    addToHistory(text: string): void {
        this.base.addToHistory?.(text);
        if (!this.promptHistory) return;
        const trimmed = text.trim();
        if (!trimmed || this.promptHistory[0] === trimmed) return;
        this.promptHistory.unshift(trimmed);
        if (this.promptHistory.length > 100) this.promptHistory.pop();
    }

    insertTextAtCursor(text: string): void {
        this.base.insertTextAtCursor?.(text);
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
        this.base.setAutocompleteProvider?.(provider);
    }

    setPaddingX(padding: number): void {
        this.base.setPaddingX?.(padding);
    }

    setAutocompleteMaxVisible(maxVisible: number): void {
        this.base.setAutocompleteMaxVisible?.(maxVisible);
    }
}

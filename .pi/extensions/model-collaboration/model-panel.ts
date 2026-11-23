import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Config, Level } from "./core.ts";

export interface ModelOption {
    key: string;
    levels: readonly Level[];
    effectiveLevel: Level;
}

/** 修改只保存在面板草稿中，Ctrl+S 返回结果，Esc 不触碰原始配置。 */
export class ModelPanel implements Component {
    private selected = 0;
    private closed = false;
    private readonly draft: Config;
    private readonly models: readonly ModelOption[];
    private readonly theme: Theme;
    private readonly done: (config: Config | undefined) => void;
    private readonly requestRender: () => void;
    private readonly height: () => number;

    constructor(options: {
        models: readonly ModelOption[];
        config: Config;
        theme: Theme;
        done: (config: Config | undefined) => void;
        requestRender: () => void;
        height: () => number;
    }) {
        this.models = options.models;
        this.draft = { ...options.config, levels: { ...options.config.levels } };
        this.theme = options.theme;
        this.done = options.done;
        this.requestRender = options.requestRender;
        this.height = options.height;
    }

    handleInput(data: string): void {
        if (this.closed) return;
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("s"))) {
            this.closed = true;
            this.done(matchesKey(data, Key.escape) ? undefined : this.draft);
            return;
        }
        if (!this.models.length) return;
        const model = this.models[this.selected];
        if (matchesKey(data, Key.up)) {
            this.selected = (this.selected - 1 + this.models.length) % this.models.length;
        } else if (matchesKey(data, Key.down)) {
            this.selected = (this.selected + 1) % this.models.length;
        } else if (matchesKey(data, Key.enter)) {
            this.draft.defaultModel = model.key;
        } else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
            if (!model.levels.length) return;
            const current = this.draft.levels[model.key] ?? model.effectiveLevel;
            const index = model.levels.indexOf(current);
            const step = matchesKey(data, Key.left) ? -1 : 1;
            // 旧配置不再受模型支持时，第一次调整恢复为支持的等级。
            this.draft.levels[model.key] = model.levels[index < 0 ? 0 : (index + step + model.levels.length) % model.levels.length];
        } else {
            return;
        }
        this.requestRender();
    }

    render(width: number): string[] {
        const count = Math.max(1, Math.min(this.models.length, this.height() - 6));
        const start = Math.max(0, Math.min(this.selected - Math.floor(count / 2), this.models.length - count));
        const lines = [this.theme.fg("accent", "子模型配置"), ""];
        for (let index = start; index < Math.min(this.models.length, start + count); index++) {
            const model = this.models[index];
            const level = this.draft.levels[model.key] ?? model.effectiveLevel;
            const suffix = ` · ${level}${this.draft.defaultModel === model.key ? " (default)" : ""}`;
            // 优先保留等级和默认标记，长模型名在左侧单独截断。
            const name = truncateToWidth(model.key, Math.max(1, width - suffix.length - 2));
            const text = `${index === this.selected ? "› " : "  "}${name}${suffix}`;
            lines.push(index === this.selected ? this.theme.fg("accent", text) : text);
        }
        if (!this.models.length) lines.push("当前没有可用模型");
        lines.push("", this.theme.fg("dim", `↑↓ 选择模型  ←→ 思考等级  Enter 设为默认  (${this.selected + 1}/${this.models.length})`),
            this.theme.fg("dim", "Ctrl+S 保存全部  Esc 放弃"));
        return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
    }

    invalidate(): void {}
}

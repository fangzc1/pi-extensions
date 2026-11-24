import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** 自渲染外壳统一预留左边距，折行正文、状态和快捷键提示使用同一边界。 */
export class CollaborationInset implements Component {
    private readonly content: Component;

    constructor(content: Component) {
        this.content = content;
    }

    invalidate(): void { this.content.invalidate(); }

    render(width: number): readonly string[] {
        if (width <= 2) return [" ".repeat(Math.max(0, width))];
        return this.content.render(width - 2).map((line) => `  ${line}`);
    }
}

/** 当前动作逐行截断，避免绝对路径折行挤走状态与最近说明。 */
export class ProgressText extends Text {
    private readonly progressText: string;

    constructor(progressText: string) {
        super(progressText, 0, 0);
        this.progressText = progressText;
    }

    override render(width: number): readonly string[] {
        return this.progressText.split("\n").map((line) => truncateToWidth(line, width));
    }
}

/** 按实际屏幕行折叠，而非按源文本行截断，避免长段落占满终端。 */
export class PreviewText extends Text {
    private readonly maxLines: number;

    constructor(text: string, maxLines = Infinity) {
        super(text, 0, 0);
        this.maxLines = maxLines;
    }

    override render(width: number): readonly string[] {
        const lines = super.render(width);
        if (lines.length <= this.maxLines) return lines;
        // Text 会复用缓存数组，不能原地修改父组件的渲染结果。
        const preview = lines.slice(0, this.maxLines);
        preview[preview.length - 1] = truncateToWidth(preview.at(-1)!, Math.max(0, width - 1), "") + "…";
        return preview;
    }
}

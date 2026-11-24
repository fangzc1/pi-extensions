import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CollaborationInset, PreviewText, ProgressText } from "../.pi/extensions/model-delegation/rendering.ts";

test("协作卡片正文折行和提示统一保留两个空格的左边距", () => {
    const content = new PreviewText("程序员相亲，对方问你有房吗？".repeat(10) + "\nctrl+o 展开详情");
    const inset = new CollaborationInset(content);
    for (const width of [0, 1, 2, 12, 40, 100]) {
        const lines = inset.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        if (width > 2) assert.ok(lines.every((line) => line.startsWith("  ")));
    }
    assert.ok(inset.render(40).at(-1)?.startsWith("  ctrl+o"));
    inset.invalidate();
});

test("当前进度的长路径不折行，窄终端仍保留各状态行", () => {
    const progress = new ProgressText(`当前：执行工具\n● 读取 /${"long-path/".repeat(40)}file.ts\n最近说明：核对消费者`);
    for (const width of [12, 40, 100]) {
        const lines = progress.render(width);
        assert.equal(lines.length, 3);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(lines[2].includes("最近说明"));
    }
});

test("长任务按实际终端行数折叠，展开保留换行和完整内容", () => {
    const task = "执行本地任务。".repeat(60) + "\n验证结果";
    const preview = new PreviewText(task, 2);
    for (const width of [12, 40, 100]) {
        const lines = preview.render(width);
        assert.equal(lines.length, 2);
        assert.ok(lines.at(-1)?.includes("…"));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    assert.ok(new PreviewText(task).render(40).at(-1)?.includes("验证结果"));
});

test("短内容不增加省略标记，重复渲染和尺寸切换不污染缓存", () => {
    const preview = new PreviewText("完成", 2);
    assert.deepEqual(preview.render(40), preview.render(40));
    assert.ok(!preview.render(40).join("").includes("…"));
    preview.render(2);
    assert.ok(preview.render(40).join("").includes("完成"));
});

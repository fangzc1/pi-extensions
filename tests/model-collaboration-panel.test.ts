import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModelPanel, type ModelOption } from "../.pi/extensions/model-delegation/model-panel.ts";
import type { Config } from "../.pi/extensions/model-delegation/core.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const models: ModelOption[] = [
    { key: "p/a", levels: ["off", "low", "high"], effectiveLevel: "low" },
    { key: "p/b", levels: ["off"], effectiveLevel: "off" },
];
function setup(config: Config = { defaultModel: "p/a", levels: {} }, options = models) {
    const results: Array<Config | undefined> = [];
    let renders = 0;
    const panel = new ModelPanel({ models: options, config, theme, done: (result) => results.push(result),
        requestRender: () => { renders++; }, height: () => 12 });
    return { panel, results, config, renders: () => renders };
}

test("方向键直接修改等级，Enter 设默认，Ctrl+S 一次提交所有草稿", () => {
    const { panel, results, config, renders } = setup();
    panel.handleInput("\u001b[C");
    assert.ok(panel.render(100).some((line) => line.includes("p/a · high (default)")));
    panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    assert.equal(results.length, 0);
    assert.equal(config.defaultModel, "p/a");
    assert.deepEqual(config.levels, {});
    panel.handleInput("\u0013");
    assert.deepEqual(results, [{ defaultModel: "p/b", levels: { "p/a": "high" } }]);
    assert.equal(renders(), 3);
    panel.handleInput("\u0013");
    assert.equal(results.length, 1);
});

test("Esc 放弃默认与思考等级的全部修改", () => {
    const { panel, results, config } = setup();
    panel.handleInput("\u001b[D");
    panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    panel.handleInput("\u001b");
    assert.deepEqual(results, [undefined]);
    assert.deepEqual(config, { defaultModel: "p/a", levels: {} });
});

test("思考等级遵守各模型能力，选择可循环", () => {
    const { panel, results } = setup();
    panel.handleInput("\u001b[A");
    panel.handleInput("\u001b[C");
    panel.handleInput("\r");
    panel.handleInput("\u0013");
    assert.deepEqual(results[0], { defaultModel: "p/b", levels: { "p/b": "off" } });
});

test("长名单可滚动，中文与窄终端渲染不超宽，默认标记仍可见", () => {
    const options = Array.from({ length: 50 }, (_, index) => ({ ...models[0], key: `provider/中文很长的模型名称-${index}` }));
    const { panel } = setup({ defaultModel: options[30].key, levels: {} }, options);
    for (let index = 0; index < 30; index++) panel.handleInput("\u001b[B");
    assert.ok(panel.render(40).some((line) => line.startsWith("› ") && line.includes("(default)")));
    assert.ok(panel.render(40).length <= 12);
    for (const width of [1, 12, 40, 100]) {
        assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
    }
});

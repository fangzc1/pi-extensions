import assert from "node:assert/strict";
import test from "node:test";

const menu = await import("./menu-model.ts").catch(() => ({} as Record<string, unknown>));

test("菜单模型支持循环导航和数字直选", () => {
    assert.equal(typeof menu.MenuModel, "function", "应提供 MenuModel");
    const Model = menu.MenuModel as new (items: Array<{ value: string; acceptsContext?: boolean }>) => any;
    const model = new Model([{ value: "a" }, { value: "b" }, { value: "c" }]);
    assert.equal(model.selected.value, "a");
    model.move(-1);
    assert.equal(model.selected.value, "c");
    model.move(1);
    assert.equal(model.selected.value, "a");
    assert.equal(model.selectNumber(2).value, "b");
});

test("菜单模型仅在允许上下文的选项上记录输入", () => {
    const Model = menu.MenuModel as new (items: Array<{ value: string; acceptsContext?: boolean }>) => any;
    const model = new Model([{ value: "restore" }, { value: "summary", acceptsContext: true }]);
    model.appendContext("x");
    assert.equal(model.context, "");
    model.move(1);
    model.appendContext("说明");
    model.backspaceContext();
    assert.equal(model.context, "说");
});

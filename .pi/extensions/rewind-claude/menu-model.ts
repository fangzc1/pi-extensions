export interface MenuItemLike<T> {
    value: T;
    acceptsContext?: boolean;
}

export class MenuModel<T> {
    private selectedIndex = 0;
    private contextValue = "";
    readonly items: Array<MenuItemLike<T>>;

    constructor(items: Array<MenuItemLike<T>>) {
        if (items.length === 0) throw new Error("Menu requires at least one item");
        this.items = items;
    }

    get index(): number {
        return this.selectedIndex;
    }

    get selected(): MenuItemLike<T> {
        return this.items[this.selectedIndex]!;
    }

    get context(): string {
        return this.contextValue;
    }

    move(delta: number): void {
        this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
    }

    selectNumber(number: number): MenuItemLike<T> | undefined {
        if (number < 1 || number > this.items.length) return undefined;
        this.selectedIndex = number - 1;
        return this.selected;
    }

    appendContext(text: string): void {
        if (!this.selected.acceptsContext) return;
        this.contextValue += text;
    }

    backspaceContext(): void {
        if (!this.selected.acceptsContext) return;
        this.contextValue = Array.from(this.contextValue).slice(0, -1).join("");
    }
}

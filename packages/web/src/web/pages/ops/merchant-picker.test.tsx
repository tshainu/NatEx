import { describe, expect, test } from "bun:test";
import * as React from "react";
import { JSDOM } from "jsdom";
import { filterBookableMerchants, MerchantPicker, type BookableMerchantOption } from "./merchant-picker";

const merchants: BookableMerchantOption[] = [
  { id: "merchant-1", name: "Alpha Shop", codEnabled: true, status: "active" },
  { id: "merchant-2", name: "South Books", codEnabled: false, status: "active" },
  { id: "merchant-3", name: "Delta Store", codEnabled: true, status: "active" },
  { id: "merchant-4", name: "Hidden Pending", codEnabled: true, status: "pending" },
  { id: "merchant-5", name: "Hidden Inactive", codEnabled: true, status: "inactive" },
];

describe("bookable merchant picker", () => {
  test("filters only active merchants by name, case-insensitively", () => {
    expect(filterBookableMerchants(merchants, "  BOOKS ").map((merchant) => merchant.id)).toEqual(["merchant-2"]);
    expect(filterBookableMerchants(merchants, "").map((merchant) => merchant.id)).toEqual([
      "merchant-1",
      "merchant-2",
      "merchant-3",
    ]);
    expect(filterBookableMerchants(merchants, "pending")).toEqual([]);
  });

  test("keeps selection controlled while searching and supports keyboard and status states", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "http://localhost",
    });
    const win = dom.window;
    const globalDescriptors = new Map<string, PropertyDescriptor | undefined>();
    const globals: Record<string, unknown> = {
      window: win,
      document: win.document,
      navigator: win.navigator,
      HTMLElement: win.HTMLElement,
      Node: win.Node,
      Event: win.Event,
      MouseEvent: win.MouseEvent,
      KeyboardEvent: win.KeyboardEvent,
      PointerEvent: win.PointerEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(globals)) {
      globalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }

    const rootElement = win.document.getElementById("root")!;
    let root: import("react-dom/client").Root | undefined;
    try {
      const { createRoot } = await import("react-dom/client");
      root = createRoot(rootElement);

      function ControlledPicker(props: {
        merchants: readonly BookableMerchantOption[];
        loading?: boolean;
        error?: string | null;
      }) {
        const [value, setValue] = React.useState("merchant-1");
        return React.createElement(MerchantPicker, {
          ...props,
          value,
          onChange: setValue,
        });
      }

      await React.act(async () => {
        root!.render(React.createElement(ControlledPicker, { merchants }));
      });
      const trigger = () => rootElement.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
      const searchInput = () => rootElement.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      const optionTexts = () => Array.from(rootElement.querySelectorAll('[role="option"]')).map((option) => option.textContent);
      const key = async (target: Element, value: string) => {
        await React.act(async () => {
          target.dispatchEvent(new win.KeyboardEvent("keydown", { key: value, bubbles: true }));
        });
      };
      const typeSearch = async (value: string) => {
        const input = searchInput();
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
        await React.act(async () => {
          setter.call(input, value);
          input.dispatchEvent(new win.Event("input", { bubbles: true }));
        });
      };

      expect(rootElement.querySelector<HTMLSelectElement>("select[required]")?.value).toBe("merchant-1");
      await React.act(async () => {
        trigger().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      });
      expect(searchInput().getAttribute("aria-expanded")).toBe("true");
      expect(win.document.activeElement).toBe(searchInput());
      expect(optionTexts()).toEqual(["Alpha Shop", "South BooksCOD disabled", "Delta Store"]);
      await key(searchInput(), "ArrowDown");
      expect(win.document.getElementById(searchInput().getAttribute("aria-activedescendant")!)?.textContent).toBe("South BooksCOD disabled");
      await key(searchInput(), "ArrowUp");
      expect(win.document.getElementById(searchInput().getAttribute("aria-activedescendant")!)?.textContent).toBe("Alpha Shop");

      await typeSearch("south");
      expect(optionTexts()).toEqual(["South BooksCOD disabled"]);
      expect(trigger().textContent).toContain("Alpha Shop");
      expect(rootElement.querySelector<HTMLSelectElement>("select[required]")?.value).toBe("merchant-1");
      expect(searchInput().getAttribute("aria-activedescendant")).toContain("option-merchant-2");
      await key(searchInput(), "Enter");
      expect(trigger().textContent).toContain("South Books");
      expect(trigger().textContent).toContain("COD disabled");
      expect(rootElement.querySelector<HTMLSelectElement>("select[required]")?.value).toBe("merchant-2");

      await React.act(async () => {
        trigger().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      });
      await key(searchInput(), "Home");
      expect(win.document.getElementById(searchInput().getAttribute("aria-activedescendant")!)?.textContent).toBe("Alpha Shop");
      await key(searchInput(), "End");
      expect(win.document.getElementById(searchInput().getAttribute("aria-activedescendant")!)?.textContent).toBe("Delta Store");
      await key(searchInput(), "Enter");
      expect(trigger().textContent).toContain("Delta Store");

      await React.act(async () => {
        trigger().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      });
      await key(searchInput(), "Escape");
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(win.document.activeElement).toBe(trigger());
      expect(trigger().textContent).toContain("Delta Store");

      await React.act(async () => {
        root!.render(React.createElement(ControlledPicker, { merchants: [], loading: true }));
      });
      await React.act(async () => {
        trigger().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      });
      expect(rootElement.textContent).toContain("Loading merchants…");

      await React.act(async () => {
        root!.render(React.createElement(ControlledPicker, { merchants: [], error: "Merchants could not be loaded." }));
      });
      expect(rootElement.querySelector('[role="alert"]')?.textContent).toBe("Merchants could not be loaded.");
      await key(searchInput(), "Escape");

      await React.act(async () => {
        root!.render(React.createElement(ControlledPicker, { merchants }));
      });
      await React.act(async () => {
        trigger().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      });
      await typeSearch("no matching merchant");
      expect(rootElement.textContent).toContain("No merchants match your search.");
      expect(optionTexts()).toEqual([]);
    } finally {
      if (root) {
        await React.act(async () => root!.unmount());
      }
      dom.window.close();
      for (const [key, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});

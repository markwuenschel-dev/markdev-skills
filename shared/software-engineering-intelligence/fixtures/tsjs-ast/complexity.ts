import type { Shape } from "./types.js";
import { helper as h } from "./helper.js";
export { shared } from "./shared.js";
export * from "./all.js";
const lazy = import("./lazy.js");
const late = import(getTarget());
const legacy = require("./legacy.cjs");
const unknownLegacy = require(getTarget());

export function decide(value: number | null): number {
  if (value !== null && value > 0) {
    for (let index = 0; index < value; index += 1) {
      if (index % 2 === 0 || index === 3) return index;
    }
  } else {
    return value ?? 0;
  }
  return value ? value : 0;
}

export class Worker {
  async run(items: string[]): Promise<boolean> {
    for (const item of items) {
      try {
        if (item === "skip") continue;
      } catch (error) {
        return false;
      }
    }
    return true;
  }
}

export const choose = (ready: boolean): number => ready && h(ready) ? 1 : 0;

export function outer(flag: boolean): number {
  function inner(value: number): number {
    while (value > 0) value -= 1;
    return value;
  }
  return flag ? inner(1) : 0;
}

export type { Shape };

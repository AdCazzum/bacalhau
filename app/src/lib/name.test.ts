import { describe, expect, it } from "vitest";

import { strategyName } from "./name";

/**
 * The label is the only human-readable handle a strategy has, and nothing
 * synchronises it: the dashboard derives it from `strategy.hash` (viem,
 * `0x`-prefixed) while the indexed page derives it from the subgraph's `id`.
 * Both must land on the same two words for the same strategy.
 *
 * Expectations here are derived from the documented indexing rule — byte 0
 * modulo 16 picks the adjective, byte 1 modulo 16 the noun — and written out
 * as literal labels. The word lists are module-private on purpose, so the
 * tests never re-declare them; they pin the mapping from the outside.
 */

/** A realistic 32-byte strategy hash whose first two bytes are `head`. */
function hashOf(head: string): string {
  return `0x${head}${"a7".repeat(30)}`;
}

const LABELS: { name: string; hash: string; label: string }[] = [
  // Index 0 of each list: the bottom of both ranges.
  { name: "0x00 0x00 -> the first adjective and the first noun", hash: hashOf("0000"), label: "amber otter" },
  // Index 15: the top of both ranges must still be addressable.
  { name: "0x0f 0x0f -> the last adjective and the last noun", hash: hashOf("0f0f"), label: "pale yarrow" },
  // 255 % 16 == 15, so a byte past the end of the list wraps rather than clamps.
  { name: "0xff 0xff wraps onto the same pair as 0x0f 0x0f", hash: hashOf("ffff"), label: "pale yarrow" },
  // 0x9c = 156 -> 12, 0x3a = 58 -> 10.
  { name: "0x9c 0x3a -> adjective 12 and noun 10", hash: hashOf("9c3a"), label: "murk tide" },
  // 0x10 = 16 -> 0 wraps the adjective on its own; 0x23 = 35 -> 3.
  { name: "0x10 0x23 -> adjective 0 and noun 3", hash: hashOf("1023"), label: "amber meridian" },
  // These two rows carry the same bytes in the opposite order: reading the
  // wrong slice, or reading the noun out of the adjective list, collapses them.
  { name: "0x05 0x00 spends the 5 on the adjective", hash: hashOf("0500"), label: "flint otter" },
  { name: "0x00 0x05 spends the 5 on the noun", hash: hashOf("0005"), label: "amber orbit" },
];

describe("strategyName (hash -> label)", () => {
  it.each(LABELS)("$name", ({ hash, label }) => {
    expect(strategyName(hash)).toBe(label);
  });
});

describe("hash spelling (every source of the same hash must agree)", () => {
  // 0xab = 171 -> 11, 0xcd = 205 -> 13.
  const LABEL = "lucid willow";

  it("ignores a leading 0x", () => {
    expect(strategyName(hashOf("abcd"))).toBe(LABEL);
    expect(strategyName(hashOf("abcd").slice(2))).toBe(LABEL);
  });

  it("accepts uppercase hex digits", () => {
    expect(strategyName(hashOf("ABCD"))).toBe(LABEL);
    expect(strategyName(hashOf("ABCD").slice(2))).toBe(LABEL);
  });

  it("reads the first two bytes and nothing past them", () => {
    expect(strategyName(`0xabcd${"00".repeat(30)}`)).toBe(LABEL);
    expect(strategyName(`0xabcd${"ff".repeat(30)}`)).toBe(LABEL);
  });

  it("keeps answering the same for a hash it has already seen", () => {
    // Guards the promise that the label needs no syncing: no cache, counter or
    // other state may let an earlier call change a later one's answer.
    const other = hashOf("1023");
    for (let call = 0; call < 5; call++) {
      expect(strategyName(other)).toBe("amber meridian");
      expect(strategyName(hashOf("abcd"))).toBe(LABEL);
    }
  });
});

describe("the label space", () => {
  const hexByte = (value: number) => value.toString(16).padStart(2, "0");

  /** The label of every one of the 65536 possible pairs of leading bytes. */
  function everyLabel(): string[] {
    const labels: string[] = [];
    for (let first = 0; first < 256; first++) {
      for (let second = 0; second < 256; second++) {
        labels.push(strategyName(hashOf(hexByte(first) + hexByte(second))));
      }
    }
    return labels;
  }

  it("is always two lowercase words separated by a single space", () => {
    const distinct = [...new Set(everyLabel())];
    expect(distinct.filter((label) => !/^[a-z]+ [a-z]+$/.test(label))).toEqual([]);
    // "undefined otter" would pass the regex above, so an index that fell off
    // the end of a word list needs its own check.
    expect(distinct.filter((label) => label.includes("undefined"))).toEqual([]);
  });

  it("is exactly 16 adjectives crossed with 16 nouns, with no pair repeated", () => {
    const labels = everyLabel();
    expect(new Set(labels.map((label) => label.split(" ")[0])).size).toBe(16);
    expect(new Set(labels.map((label) => label.split(" ")[1])).size).toBe(16);
    // 256 distinct labels means every adjective meets every noun and no two
    // reachable index pairs share a label.
    expect(new Set(labels).size).toBe(256);
  });
});

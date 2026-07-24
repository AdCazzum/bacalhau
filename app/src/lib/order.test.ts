import { describe, expect, it } from "vitest";

import { buildAquaOrder, decodeOrder, encodeOrder, takerData, USE_AQUA_TRAIT } from "./order";

const MAKER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

describe("order encoding (MakerTraits, Aqua mode)", () => {
  it("aqua trait is exactly bit 254", () => {
    expect(USE_AQUA_TRAIT).toBe(2n ** 254n);
  });

  it("encode/decode roundtrip preserves the order", () => {
    const order = buildAquaOrder(MAKER, "0x1504002dc6c01100");
    const decoded = decodeOrder(encodeOrder(order));
    expect(decoded.maker.toLowerCase()).toBe(MAKER.toLowerCase());
    expect(decoded.traits).toBe(USE_AQUA_TRAIT);
    expect(decoded.data).toBe("0x1504002dc6c01100");
  });
});

describe("taker data (TakerTraits header)", () => {
  it("simple exact-in taker = 20 zero bytes + flags 0x0005", () => {
    // slicesIndexes (uint160=0) + IS_EXACT_IN|HAS_PRE_TRANSFER_IN_CALLBACK
    expect(takerData(true)).toBe(`0x${"00".repeat(20)}0005`);
  });

  it("exact-out drops the exact-in bit", () => {
    expect(takerData(false)).toBe(`0x${"00".repeat(20)}0004`);
  });
});

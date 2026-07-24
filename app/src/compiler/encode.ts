/** Minimal big-endian byte encoding helpers (no dependencies). */

export function toHex(bytes: Uint8Array): `0x${string}` {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Unsigned big-endian, fixed width in bytes. Throws on overflow. */
export function uintBE(value: bigint, width: number): Uint8Array {
  if (value < 0n) throw new Error(`negative value: ${value}`);
  if (value >= 1n << BigInt(8 * width)) {
    throw new Error(`value ${value} does not fit in ${width} bytes`);
  }
  const out = new Uint8Array(width);
  let v = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * One VM instruction: [opcode: 1 byte][argsLen: 1 byte][args].
 * Mirrors ProgramBuilder.build in swap-vm/test/utils/ProgramBuilder.sol.
 */
export function instruction(opcode: number, args: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (opcode < 0 || opcode > 0xff) throw new Error(`opcode out of range: ${opcode}`);
  if (args.length > 0xff) throw new Error(`args too long: ${args.length} bytes`);
  return concatBytes(new Uint8Array([opcode, args.length]), args);
}

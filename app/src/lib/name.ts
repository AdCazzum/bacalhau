/**
 * Human-readable label for a strategy, derived from its hash.
 *
 * Strategies are identified on-chain only by a 32-byte hash, and two of them
 * on the same pair are indistinguishable at a glance. Rather than store names
 * somewhere the chain and the subgraph cannot see, the label is a pure
 * function of the hash: the app, the indexed page and anyone reading the
 * events derive the same name for the same strategy, with nothing to sync.
 */
const ADJECTIVES = [
  "amber", "brisk", "cobalt", "dusk", "ember", "flint", "gilded", "hollow",
  "ivory", "jade", "keen", "lucid", "murk", "noble", "onyx", "pale",
];

const NOUNS = [
  "otter", "harbor", "lantern", "meridian", "narwhal", "orbit", "prism", "quarry",
  "reef", "sable", "tide", "umber", "vector", "willow", "xenon", "yarrow",
];

/**
 * `0x9c3a…` -> `murk tide`. Same hash always yields the same two words.
 *
 * Lowercased first: viem hands us `0x…`, but a hash pasted from a block
 * explorer can arrive as `0X…`, and a missed prefix would feed `parseInt` a
 * `NaN` index that renders as the literal word "undefined".
 */
export function strategyName(hash: string): string {
  const lower = hash.toLowerCase();
  const hex = lower.startsWith("0x") ? lower.slice(2) : lower;
  const adjective = ADJECTIVES[parseInt(hex.slice(0, 2), 16) % ADJECTIVES.length];
  const noun = NOUNS[parseInt(hex.slice(2, 4), 16) % NOUNS.length];
  return `${adjective} ${noun}`;
}

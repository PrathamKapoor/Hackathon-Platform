/**
 * Seeded pseudo-random number generation.
 *
 * Randomness is permitted in exactly two places: public gallery ordering and
 * the "random" assignment strategy. Both must be reproducible, so neither may
 * call `Math.random()`. We use SplitMix64 to derive seeds from a string and
 * xoshiro128** to generate the stream — both are tiny, well-documented, and
 * produce identical sequences on every platform because all arithmetic is
 * done with explicit 32-bit integer ops.
 */

/** FNV-1a 32-bit string hash — used to derive a numeric seed from a string. */
export function hashStringToSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** SplitMix32: expands a 32-bit seed into a stream of well-distributed words. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export type Rng = {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Fisher–Yates shuffle returning a new array. */
  shuffle<T>(items: readonly T[]): T[];
};

/**
 * Build a deterministic RNG from a textual seed.
 * The same seed string always yields the same sequence, on every machine.
 */
export function createRng(seed: string | number): Rng {
  const base = typeof seed === 'number' ? seed >>> 0 : hashStringToSeed(seed);
  const nextWord = splitmix32(base);
  // xoshiro128** needs 128 bits of state; derive from four successive words.
  let s0 = nextWord();
  let s1 = nextWord();
  let s2 = nextWord();
  let s3 = nextWord();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

  const nextUint32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7) >>> 0, 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  };

  return {
    next(): number {
      return nextUint32() / 0x100000000;
    },
    int(maxExclusive: number): number {
      if (maxExclusive <= 0) return 0;
      return nextUint32() % maxExclusive;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = nextUint32() % (i + 1);
        const a = out[i] as T;
        const b = out[j] as T;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
  };
}

/**
 * Stable, content-derived ordering key.
 *
 * Used for randomised-but-reproducible gallery ordering: given the same event
 * and the same viewing session, every visitor sees the same order (avoiding
 * the "page reload reshuffles everything" effect) while different events and
 * different days produce different orders.
 */
export function galleryOrderKey(eventId: string, salt: string, id: string): string {
  const seed = hashStringToSeed(`${eventId}:${salt}:${id}`);
  return seed.toString(16).padStart(8, '0');
}

/** Deterministic ordering of submissions for the gallery given a daily salt. */
export function seededGalleryOrder<T extends { id: string }>(
  items: readonly T[],
  eventId: string,
  salt: string,
): T[] {
  return [...items].sort((a, b) => {
    const ka = galleryOrderKey(eventId, salt, a.id);
    const kb = galleryOrderKey(eventId, salt, b.id);
    if (ka === kb) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return ka < kb ? -1 : 1;
  });
}

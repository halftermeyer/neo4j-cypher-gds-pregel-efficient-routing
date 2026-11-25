// Seeded deterministic RNG (mulberry32). Same seed, same network, on every machine.
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** integer in [lo, hi] inclusive */
  int(lo: number, hi: number): number { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  randrange(n: number): number { return Math.floor(this.next() * n); }
  choice<T>(xs: readonly T[]): T { return xs[this.randrange(xs.length)]; }
  /** n distinct elements */
  sample<T>(xs: readonly T[], n: number): T[] {
    const pool = [...xs];
    const out: T[] = [];
    for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(this.randrange(pool.length), 1)[0]);
    return out;
  }
}

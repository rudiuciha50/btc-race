// Baseline: cross-sectional momentum. It holds the top n symbols by trailing 24-bar return and
// rebalances every 24 bars, long only, with no fitted parameter: the lookback and the period are 24
// bars, n = min(MOMENTUM_TOP_N = 3, caps.max_open_positions, caps.max_orders_per_bar), the rest comes
// from hello. Holding fewer than half the universe is what makes it rotate: with n at the caps alone
// (10 positions over solana-bars-1h-01's 7 assets) it bought all 7 a day late and held them, a
// late buy-and-hold (#1218).
//
//   - Return: a symbol's latest close now against its latest close as of 24 batches back (compared
//     exactly, cross-multiplied); a symbol without both is not ranked. Ties go to code-unit order.
//   - Rebalance bars: batch 24, 48, 72, ... (the first one with 24 bars of history); with a warm-up
//     (hello.warmup_bars, N) the first is batch max(24, N), the first it can trade on with that
//     history (the warm-up's bars count), then every 24 after it. The target is the
//     top n ranked symbols. It sells the whole position of every held symbol outside the target, and
//     buys the target symbols it does not hold. A sell's proceeds land at the next open and never fund
//     a buy of the same reply, so when it sold anything it sends the buys on the next batch, with the
//     proceeds in cash; otherwise on the rebalance bar itself.
//   - Buys: the cash split evenly over the symbols coming in (no more of them than n less the symbols
//     held, so it never holds more than n and a rebalance's sells fit one reply), each capped by
//     caps.max_weight_bps of equity; below fees.min_notional_quote_units it buys nothing. Kept
//     positions are never resized.
//   - Slippage is left wide open (MAX_SLIPPAGE_BPS = 10_000). An order the market refuses is retried
//     at the next rebalance if the symbol is still in the target.
//
// Laid out like an entrant's repository: the grader runs `node /bot/main.ts` with this directory
// mounted at /bot; vendor/makefun-bars.ts is a byte-identical copy of bars/sdk/makefun-bars.ts
// (tests/unit/baselines.test.ts keeps it so).

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK_BARS = 24;
/** The most symbols it holds: fewer than half the universe (7 in solana-bars-1h-01), so it rotates. */
const MOMENTUM_TOP_N = 3;
const MAX_SLIPPAGE_BPS = 10_000;

/** Each universe symbol's latest close as of every batch so far (null before its first bar), by seq. */
const history = new Map<string, (bigint | null)[]>();
/** The next rebalance bar; set from hello: max(LOOKBACK_BARS, the warm-up's batches). */
let nextRebalance = LOOKBACK_BARS;
/** The symbols to buy on this batch, chosen on the rebalance bar before it (whose sells have now filled). */
let entering: string[] | null = null;

/** How many symbols it holds at most: n, MOMENTUM_TOP_N unless a cap is tighter. */
const slots = (state: BarsState) => Math.min(MOMENTUM_TOP_N, state.hello.caps.max_open_positions, state.hello.caps.max_orders_per_bar);

/** The top n symbols by trailing return as of batch `seq`, best first. */
function target(state: BarsState, seq: number): string[] {
  const ranked: { symbol: string; now: bigint; then: bigint }[] = [];
  for (const { symbol } of state.hello.symbols) {
    const closes = history.get(symbol)!;
    const now = closes[seq];
    const then = closes[seq - LOOKBACK_BARS];
    if (now !== null && now !== undefined && then !== null && then !== undefined) ranked.push({ symbol, now, then });
  }
  // now_a / then_a > now_b / then_b, exactly; Array.prototype.sort is stable, so ties keep universe order.
  ranked.sort((a, b) => {
    const l = a.now * b.then;
    const r = b.now * a.then;
    return l > r ? -1 : l < r ? 1 : 0;
  });
  return ranked.slice(0, slots(state)).map((x) => x.symbol);
}

function buys(state: BarsState, symbols: readonly string[]): BuyInput[] {
  const { caps, fees } = state.hello;
  const room = slots(state) - state.positions.size;
  const coming = symbols.filter((s) => !state.positions.has(s) && state.close(s) !== null).slice(0, room > 0 ? room : 0);
  if (coming.length === 0) return [];
  const even = state.cash / BigInt(coming.length);
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  const slice = even < byWeight ? even : byWeight;
  if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
  return coming.map((symbol) => ({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS }));
}

await runBars({
  onHello(state) {
    nextRebalance = Math.max(LOOKBACK_BARS, state.warmupBars);
  },
  onBatch(state, batch) {
    for (const { symbol } of state.hello.symbols) {
      const closes = history.get(symbol) ?? [];
      closes.push(state.close(symbol));
      history.set(symbol, closes);
    }
    if (entering !== null) {
      const orders = buys(state, entering);
      entering = null;
      return orders;
    }
    if (batch.seq < nextRebalance) return [];
    nextRebalance = batch.seq + LOOKBACK_BARS;
    const want = target(state, batch.seq);
    const sells: OrderInput[] = [...state.positions]
      .filter(([symbol]) => !want.includes(symbol))
      .map(([symbol, p]) => ({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }));
    if (sells.length === 0) return buys(state, want);
    entering = want;
    return sells;
  },
});

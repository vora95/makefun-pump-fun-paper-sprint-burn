// Second-wave dip-buy bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2) — burn entry, @gentle-lynx-64.
//
// IDEA — "proven-runner dip-buy": only buy dips on coins that already
// proved they can run. A coin qualifies when (a) its price peaked at
// >= 2x its creation price, and (b) it has since pulled back >= 30%
// from that peak. The bot buys INTO the dip, at the dip — it does not
// wait for a reclaim: backtests on the dev window showed waiting for a
// 12% reclaim off the dip low loses money (the bounce is over by the
// time the reclaim prints), while buying the dip itself is net
// positive. Quality filters keep it off the worst coins: >= 8 distinct
// buyers, >= 15 trades, age 50-7200 slots, creator has not sold.
//
// EXITS are all-in and fast — runners give their gains back within
// minutes on this data (median coin ends far below its dip-buy price
// a few thousand slots later): sell everything at +25%, hard stop at
// -10%, max hold 600 slots (~4 min). One shot per coin, 0.25 SOL per
// entry (capped at 1% of the coin's real SOL reserve, skipped when the
// cap makes the stake smaller than 0.15 SOL), at most 5 open positions.
//
// PACE GUARDRAIL: the competition needs a >= 0.01 SOL round trip on
// >= 20 distinct mints and <= 50% max drawdown. If distinct coins
// traded lag behind slot progress, entry thresholds relax in
// deterministic tiers (inputs are slot numbers and counts from the
// replay itself — no clock, no random).
//
// DETERMINISM: every decision derives from replay events; the hello
// seed is unused, no clock / Math.random / env. The same replay yields
// the same orders, so the two house executions match byte-for-byte.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** SOL staked per entry, before the 1%-of-real-reserve cap. */
  stakeLamports: bigint;
  /** Skip an entry if the reserve cap makes the stake smaller than this. */
  minStakeLamports: bigint;
  /** Entry tier 0: peak must be >= this multiple of the creation price. */
  peakMinX: number;
  /** Entry tier 0: price must have pulled back >= this fraction from peak. */
  pullbackMin: number;
  /** Minimum distinct wallets that bought the coin before entry. */
  minDistinctBuyers: number;
  /** Minimum trades seen before entry. */
  minTrades: number;
  /** Youngest / oldest age (slots) at which a coin may be entered. */
  minAgeSlots: number;
  maxAgeSlots: number;
  /** Sell everything once mark value reaches this multiple of cost. */
  tpX: number;
  /** Hard stop: sell all if mark value falls to this multiple of cost. */
  stopX: number;
  /** Max hold in slots; sell all when exceeded. */
  maxHoldSlots: number;
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 250_000_000n,
  // 0.15 SOL: only trade coins whose real SOL reserve is >= 15 SOL at
  // entry. Smaller stakes lose money on thin curves (own fills move the
  // price + curve/tx fees dominate); 0.15 SOL is the smallest stake
  // that stays net positive on the dev window.
  minStakeLamports: 150_000_000n,
  peakMinX: 2.0,
  pullbackMin: 0.3,
  minDistinctBuyers: 8,
  minTrades: 15,
  minAgeSlots: 50,
  maxAgeSlots: 7200,
  tpX: 1.25,
  stopX: 0.9,
  maxHoldSlots: 600,
  buySlippageBps: 500,
  sellSlippageBps: 1000,
};

/** Relaxed entry tiers when distinct coins traded lag slot progress. */
const RELAXED_TIERS = [
  { afterProgress: 0.25, needTraded: 5, peakMinX: 1.6, pullbackMin: 0.2 },
  { afterProgress: 0.5, needTraded: 10, peakMinX: 1.4, pullbackMin: 0.15 },
  { afterProgress: 0.75, needTraded: 15, peakMinX: 1.3, pullbackMin: 0.12 },
] as const;

/** A 24h replay is ~400k slots; used only to measure pace progress. */
const WINDOW_SLOTS = 400_000;

interface CoinTape {
  mint: string;
  createdSlot: number | null;
  creator: string | null;
  createPrice: number;
  peak: number;
  dipLow: number;
  trades: number;
  distinctBuyers: Set<string>;
  creatorSold: boolean;
  complete: boolean;
  traded: boolean;
}

function priceOf(quoteReserves: bigint, tokenReserves: bigint): number {
  if (tokenReserves <= 0n) return 0;
  return Number(quoteReserves) / Number(tokenReserves);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<string, CoinTape>();
  const holdStartByMint = new Map<string, number>();
  let firstSlot = 0;
  let tradedCount = 0;

  function tapeFor(mint: string): CoinTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        mint,
        createdSlot: null,
        creator: null,
        createPrice: 0,
        peak: 0,
        dipLow: Number.POSITIVE_INFINITY,
        trades: 0,
        distinctBuyers: new Set<string>(),
        creatorSold: false,
        complete: false,
        traded: false,
      };
      tapes.set(mint, t);
    }
    return t;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (firstSlot === 0) firstSlot = batch.slot;
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    // --- 1. Absorb the batch's events into the per-coin tape. ---
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        const t = tapeFor(ev.mint);
        t.createdSlot = ev.slot;
        t.creator = ev.creator;
        const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
        t.createPrice = p;
        t.peak = p;
        t.dipLow = Number.POSITIVE_INFINITY;
      } else if (ev.event === 'TradeEvent') {
        const t = tapeFor(ev.mint);
        const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
        t.trades += 1;
        if (ev.is_buy) {
          t.distinctBuyers.add(ev.user);
        } else if (t.creator !== null && ev.user === t.creator) {
          t.creatorSold = true;
        }
        if (t.peak > 0 && p > t.peak) {
          // New peak: the old dip is stale, restart the dip watch here.
          t.peak = p;
          t.dipLow = Number.POSITIVE_INFINITY;
        } else if (t.peak > 0 && p < t.peak) {
          if (p < t.dipLow) t.dipLow = p;
        }
      } else if (ev.event === 'CompleteEvent') {
        tapeFor(ev.mint).complete = true;
      }
    }

    // --- 2. Rejected buys free the coin for a later retry. ---
    for (const f of batch.fills) {
      if (f.status === 'rejected' && f.side === 'buy') {
        const t = tapes.get(f.mint);
        if (t !== undefined && t.traded) {
          t.traded = false;
          tradedCount -= 1;
        }
      }
    }

    // --- 3. Exits first: manage every open position from its mark. ---
    // state.positions is a Map<mint, Holding>; iterate entries, not values.
    const held = new Set<string>();
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      held.add(mint);
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      const price = curve !== undefined ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
      if (price <= 0 || pos.token_amount <= 0n) continue;
      const value = (pos.token_amount * BigInt(Math.floor(price * 1e9))) / 1_000_000_000n;
      const cost = pos.cost_lamports > 0n ? pos.cost_lamports : 1n;
      const ratio = Number(value) / Number(cost);
      // Start the hold timer when the position is first SEEN held, not
      // when the buy order was sent (the fill lands 2 slots later;
      // setting it at order time lets the cleanup delete it before the
      // fill arrives, so max-hold would never fire).
      let buySlot = holdStartByMint.get(mint);
      if (buySlot === undefined) {
        buySlot = slot;
        holdStartByMint.set(mint, buySlot);
      }
      if (ratio >= params.tpX || ratio <= params.stopX || slot - buySlot >= params.maxHoldSlots) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: params.sellSlippageBps });
      }
    }
    for (const mint of [...holdStartByMint.keys()]) {
      if (!held.has(mint)) holdStartByMint.delete(mint);
    }

    // --- 4. Entries: proven-runner dip-buy, at the dip. ---
    const progress = Math.min(1, Math.max(0, (slot - firstSlot) / WINDOW_SLOTS));
    let peakMinX = params.peakMinX;
    let pullbackMin = params.pullbackMin;
    for (const tier of RELAXED_TIERS) {
      if (progress > tier.afterProgress && tradedCount < tier.needTraded) {
        peakMinX = tier.peakMinX;
        pullbackMin = tier.pullbackMin;
      }
    }

    if (state.committedPositionCount() < 5 && orders.length < 16) {
      for (const [mint, curve] of state.curves) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= 5) break;
        const t = tapes.get(mint);
        if (t === undefined || t.complete || t.traded || held.has(mint)) continue;
        if (t.createdSlot === null || t.createPrice <= 0 || t.peak <= 0) continue;
        const age = slot - t.createdSlot;
        if (age < params.minAgeSlots || age > params.maxAgeSlots) continue;
        if (t.trades < params.minTrades) continue;
        if (t.distinctBuyers.size < params.minDistinctBuyers) continue;
        if (t.creatorSold) continue;
        // Proof: peaked high enough above the creation price.
        if (t.peak < t.createPrice * peakMinX) continue;
        // Dip: pulled back far enough from the peak, and we are IN the dip now.
        if (t.dipLow === Number.POSITIVE_INFINITY || t.dipLow > t.peak * (1 - pullbackMin)) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0 || price > t.peak * (1 - pullbackMin)) continue;
        // Size: 0.25 SOL, capped at 1% of real SOL reserve, skip if too small.
        const cap = state.maxBuyLamports(mint);
        const stake = params.stakeLamports < cap ? params.stakeLamports : cap;
        if (stake < params.minStakeLamports) continue;
        if (state.freeCashLamports() < stake + 105_000n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: params.buySlippageBps });
        t.traded = true;
        tradedCount += 1;
      }
    }

    return orders;
  }

  return { onBatch };
}

export { LAMPORTS_PER_SOL };

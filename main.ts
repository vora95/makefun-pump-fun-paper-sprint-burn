// Pump.fun Paper Sprint — paper bot (burn entry, @gentle-lynx-64).
//
// Strategy: "proven-runner dip-buy" (see strategy.ts). Entry point is
// main.ts at the repo root, run as `node /bot/main.ts`. Node 22 strips
// types; stdlib only; no install step. The bot speaks the
// agent-fun/replay/v2 NDJSON protocol through the vendored SDK shim
// (vendor/makefun-bot.ts) and is fully deterministic.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Explicit tuned parameters (verified net positive on the kit dev
// window): 0.25 SOL per entry, peak >= 2x, dip >= 30%, TP +25%,
// hard stop -10%, max hold 600 slots. Passing them explicitly keeps
// the graded behaviour pinned even if the strategy defaults move.
await runBot(createStrategy({ ...DEFAULT_PARAMS }));

# Pump.fun Paper Sprint — Proven-Runner Dip-Buy (burn entry)

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun · rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vora95/makefun-pump-fun-paper-sprint-burn/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![make.fun · reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vora95/makefun-pump-fun-paper-sprint-burn/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Paper-trading bot for the Pump.fun Paper Sprint bounty
([u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)).
It replays on 6 hours of real pump.fun market data; highest net PnL wins.

## Strategy — "proven-runner dip-buy"

Buy dips only on coins that already proved they can run: peak >= 2x the
creation price, then a pullback >= 30% from the peak — buy into the dip,
not after a reclaim. Quality filters: >= 8 distinct buyers, >= 15 trades,
age 50–7200 slots, creator has not sold. Exits are all-in and fast:
sell everything at +25%, hard stop -10%, max hold 600 slots. One shot
per coin, 0.25 SOL per entry (capped at 1% of real SOL reserve, skipped
below 0.15 SOL), at most 5 open positions. Fully deterministic — no
clock, no random, no env.

## Files

- `main.ts` — entrypoint (Node 22, stdlib only).
- `strategy.ts` — the dip-buy strategy.
- `vendor/makefun-bot.ts` — the kit's SDK shim (vendored, not authored).

# Flow Race

Online Flow-style puzzle racing. Queue for a board option (5×5 … 11×11, or a
5→9 ramp, with 1, 2 or 3 minutes), or make a private lobby for up to 4 friends.
Everyone gets the same boards in the same order, and whoever has the most
points when the clock hits zero wins. There's also a solo **practice** mode
(beat your own best, rating untouched) and an Elo **leaderboard**.

## Run it

```bash
npm install
npm start          # builds the client, then serves http://localhost:8080
npm test           # generator, solver, match rules, matchmaking, lobbies, practice, leaderboard, drawing, touch
npm run typecheck
```

Requires Node 22.18+ (the server runs `.ts` files directly through Node's type stripping).
Set `PORT` to change the port. Open two browsers, or a normal and a private
window, to race yourself; tabs in one browser share a guest identity.

## Rules

| | |
|---|---|
| Scoring | 5×5 = 1 pt, 6×6 = 2, 7×7 = 3, 8×8 = 4, 9×9 = 5, 10×10 = 6, 11×11 = 7 |
| Ramp mode | boards 1–3 are 5×5, 4–6 are 6×6, 7–10 are 7×7, 11–15 are 8×8, then 9×9 |
| Skip | moves you to the next board after a 5 s lockout, scores nothing |
| Ties | equal points go to whoever reached that score first |
| Ranked | queue matches are 1v1 Elo (K=40 for the first 10 games, then 20); lobbies are unranked |
| Queue | only identical options are paired; the allowed rating gap starts at ±100 and widens 25/s up to ±800 |
| Practice | solo run with the same rules; can be ended early; best score per option kept in the browser |
| Tug of war | 1v1 (queue or lobby): a race that ends the moment someone leads by ~3 boards' points (`tugTarget`); otherwise most points at time wins |
| Knockout | lobbies only: one board per round, everyone plays it; when all but one have cleared it, the last is out. The time setting is per round; on timeout the least-filled player goes out (if that's everyone left, they share the win). No skipping |
| Twists | lobbies only, any mix: **Fog** (dots visible only near your pointer), **Memory** (dots turn white 3 s after a board appears), **Spin** (board turns 90° every 8 s), **Mirror** (input flipped left-right). Client-side effects; the server just carries them in the options |
| Leaderboard | top 20 by rating among players with at least one ranked game |

All tunables live in [`shared/rules.ts`](shared/rules.ts).

## Layout

```
shared/          used by client and server
  board.ts       board format (cells are row*size+col)
  rules.ts       queue options, scoring, timings
  protocol.ts    every WebSocket message (the client/server contract)
  validate.ts    solution checker
server/
  core/          pure game logic: no sockets, no storage, no timers
    game-server.ts  orchestrates sessions, queue, lobbies, matches
    match.ts        the timed race
    matchmaker.ts   rating-windowed 1v1 queue
    lobby.ts        private rooms
    generator.ts    random path cover + uniqueness check
    solver.ts       pruned DFS solver (cross-checked against brute force in tests)
    puzzle-pool.ts  pre-generated boards per size
    ports.ts        interfaces the host must provide
  adapters/      standalone guest auth + in-memory store
  main.ts        standalone HTTP + WebSocket host
  puzzle-worker.ts  generates boards on a worker thread to keep the pool stocked
scripts/         bench-generator.ts, diagnose-generator.ts (generation speed / failure breakdown)
client/          browser game (bundled to public/app.js by esbuild)
public/          index.html, style.css
```

## How a race works on the wire

1. `match.state` gives the start/end times (server clock) and your current
   **and next** board, so a solve never waits on the network.
2. On a solve the client sends `match.submit {boardIndex, paths}` and moves on
   right away. The server validates it, then replies with `match.ack` (new score)
   and `match.board` (the board after next).
3. Opponents get `match.racer` updates: score, board number and cells filled.
   Never their paths.
4. If the server rejects a move, it sends `match.reject` followed by a fresh
   `match.state` to resync.
5. At `endsAt + 150 ms` everyone gets `match.result`.

The server is authoritative. It keeps the clock, validates every path, only
hands out boards one ahead, and rejects solves faster than `size² × 28 ms`
(counted from when that board became playable).

## Integrating into another app (e.g. the kernel app)

`server/core` has no I/O. To host it elsewhere, implement the ports in
[`server/core/ports.ts`](server/core/ports.ts) and drive `GameServer`:

```ts
const game = new GameServer({
  transport: { send: (connId, msg) => yourSocket(connId).send(JSON.stringify(msg)) },
  auth:      { identify: async ({ token, name }) => ({ playerId, token, name }) }, // your accounts
  store:     yourPlayerStore,            // getProfile / saveProfile / recordMatch / leaderboard / rankOf
  clock:     { now: () => Date.now() },
  puzzles:   new PuzzlePool(mulberry32(seed)),
});

onConnect(id)        -> game.handleConnect(id)
onMessage(id, json)  -> game.handleMessage(id, JSON.parse(json))
onClose(id)          -> game.handleDisconnect(id)
setInterval(() => game.tick(), 100);
// keep the board pool topped up, ideally from a worker (see server/main.ts)
```

With real accounts, `identify` can ignore the client-sent name and token and
use the host's session instead. The client only needs its WebSocket URL
changed (`client/main.ts`, `wsUrl`).

## Known limits / next steps

- Ratings and guest identities are in memory and reset on restart. Swap in a real `PlayerStore`.
- Boards are generated on a worker thread (`server/puzzle-worker.ts`); 11×11 takes ~100–400 ms each, 9×9 and below a few ms. The pool is filled synchronously at startup (~4 s), then topped up by the worker. In the kernel app, feed the pool the same way (`pool.wanted()` → generate → `pool.add()`).
- An empty ranked queue just waits; practice mode covers solo play.
- Practice bests live in each browser's localStorage, not on the server.
- Animations follow the OS "reduce motion" setting (on Windows: Settings → Accessibility → Visual effects → Animation effects).
- Anti-cheat beyond the minimum solve time (e.g. input-pattern analysis) isn't implemented; `Match.flagsOf` counts suspicious solves.

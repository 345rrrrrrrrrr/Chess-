# ♞ Adaptive Chess Trainer

A chess opponent that **starts dumb, learns how _you_ think, and turns your mind
into a prediction machine.**

This is not just "play the computer." Every move you make is graded against the
best move, the opponent's strength rises and falls to keep you in the zone where
you learn fastest, and a **Vision panel** shows you the possible futures branching
out of the current position — so you train your brain to _see the endings before
you move_.

It runs entirely in your browser. No install, no account, no server. Your
progress is saved locally on your machine.

## How to run

**Option A — just open it.** Double-click `index.html` (or open it in your
browser). Everything works offline from the file system.

**Option B — local server** (recommended, avoids any browser file:// quirks):

```bash
cd Chess-
python3 -m http.server 8000
# then open http://localhost:8000
```

You play **White**. Click a piece, then click a highlighted square to move.

## What makes it adaptive

After every one of your moves the engine quietly answers: *how close was that to
the best move?* That "centipawn loss" becomes an accuracy score and feeds a
**momentum** signal:

- Play accurately → momentum rises → the bot levels up (deeper search, fewer
  deliberate slips).
- Struggle → momentum falls → the bot eases off so you can rebuild.

There are seven strength tiers, from **Beginner Bot** (looks one move ahead and
blunders on purpose) to **Ruthless Bot** (deep search, no mercy). You are always
playing the opponent that helps you improve the most _right now_.

## The training tools

| Tool | What it does |
| --- | --- |
| **Move Coach** | Grades each move (Brilliant → Blunder), shows your accuracy and the exact "flawless" line you could have played, drawn as an arrow on the board. |
| **Vision panel** | The engine's top continuations with evaluations and follow-up lines — your "100 possible endings." Click one to see the arrow. |
| **Hint** | Draws an arrow to the best move when you're stuck — but try to see _why_ first. |
| **Profile** | Tracks accuracy, win/loss record, best-move streak, blunders and brilliancies. Persists across sessions. |

## Project structure

```
index.html      # layout + loads the scripts
styles.css      # all styling
js/chess.js     # 0x88 rules engine: legal moves, check/mate, castling,
                #   en passant, promotion, FEN, make/unmake (perft-verified)
js/ai.js        # negamax + alpha-beta search, quiescence, piece-square eval,
                #   adjustable strength (depth + deliberate-blunder rate)
js/adaptive.js  # the learning brain: skill profile, momentum, level tiers
js/coach.js     # move grading + the vision / "possible futures" lines
js/ui.js        # board rendering, click-to-move, promotion, hint arrows
js/app.js       # the controller wiring it all together
```

## Correctness

The rules engine is verified with **perft** (the standard move-generation
correctness test). From the start position and the tricky "Kiwipete" position it
matches the known reference node counts exactly to depth 3–4, which exercises
castling, en passant, promotions and pinned-piece edge cases.

## Roadmap ideas

- Opening-book awareness and themed tactic drills targeting your weak spots.
- "Predict the engine's move" mode that scores how many futures you foresaw.
- Endgame tablebase practice once you crush the Ruthless Bot.

Built for relentless improvement. Go beyond. 🔮

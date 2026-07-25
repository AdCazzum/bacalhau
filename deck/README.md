# Pitch deck

10 slides, ~2:30 spoken, with a DEMO slide in the middle. Content lives in
[`slides.md`](slides.md) — edit that, not the HTML. Speaker notes (per-beat
timings) are under each slide's `Note:` block; press `s` for the notes window.

reveal.js is vendored in `lib/` so the deck works with no network at all —
which is the point, on hackathon wifi.

```bash
cd deck && python3 -m http.server 8899   # then open http://localhost:8899
```

A file:// open will not work: the markdown is fetched at runtime.

Keys: `→`/`space` next, `s` speaker notes, `f` fullscreen, `o` overview,
`b` blackout (use it when you switch to the live app).

Assets: `pipeline.svg` (canvas → bytecode → Aqua → indexer),
`statemachine.svg` (the 0x23 branch), `keyart.jpg` (copied from the app).

/**
 * `bunfig.toml`'s `[test].preload` runs this before ANY test file loads, in
 * the same process every test (unit AND the black-box CLI subprocess seam,
 * which inherits `process.env`) runs in. Setting the notifier's test-seam
 * switch here — once, globally — is what makes "tests swap the macOS
 * sender for a recorder through the environment" (ticket 08) hold for every
 * test, not just ones that remember to opt in: a test written before the
 * notifier existed (tickets 01-07) must never start popping real macOS
 * notifications just because this ticket landed.
 *
 * Same reasoning for the Daemon's browser-opener seam (ticket 07):
 * `TENAZA_OPEN_RECORDER` set globally means NO test — present or future —
 * can ever shell out to the real macOS `open` just by forgetting to opt in.
 *
 * Same reasoning again for the focuser port (ticket 11, `src/focus.ts`):
 * `TENAZA_FOCUS_RECORDER` set globally means no test can ever shell out to
 * a real `tmux switch-client`, `osascript`, or `open -b` just by forgetting
 * to opt in — a human clicking "ir a terminal" is the only thing that
 * should ever actually move a window.
 */
process.env.TENAZA_NOTIFY_RECORDER = "1";
process.env.TENAZA_OPEN_RECORDER = "1";
process.env.TENAZA_FOCUS_RECORDER = "1";

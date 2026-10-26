# A broken Tenaza never adds a block

When Tenaza itself breaks — a malformed Policy, a torn log line, a crash — the call goes ahead
and the human is warned loudly (in the session, at session start, in the statusline and view);
a deny Tenaza already decided still holds, and a malformed Policy falls back to the last one that
parsed. Failing closed would freeze every agent over one typo, and Tenaza's promise is to block
only what already needs the human; when it is down, Claude Code's own permission classifier still
guards, which is exactly the state without Tenaza. Trades a silent-hole-free fallback to the
classifier for never getting in the way.

# Rules match the commands a line executes, not its text

A Rule's words match when they appear as a contiguous run inside a command the shell line
actually executes, found by parsing the line with tree-sitter-bash (re-parsing `bash`/`sh`/`zsh
-c` and `eval` strings); a line that fails to parse falls back to the old substring match. Plain
substring matching denied commands that merely mentioned a reserved action (a search, a heredoc,
a commit message), and under live answering each false positive freezes an agent for minutes.
Trades ~17 ms on lines that name a Rule's first word, and a parser on the hook path, for matching
on what runs; a contiguous run anywhere was chosen over leading-word matching because it catches
wrapped commands (`timeout 60 gh pr merge`) without a per-launcher table to keep current.

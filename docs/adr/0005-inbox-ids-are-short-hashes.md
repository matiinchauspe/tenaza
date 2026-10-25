# Inbox ids are short hashes, not counters

An Inbox item is identified by its Session and the line of its Event in that Session's log, shown
as a git-style short hash (shortest unique prefix, ambiguous prefixes refused). Positional numbers
shifted when a deny landed late, and a shared counter would need a lock parallel hooks contend on;
trades memorable, ordered `#14`s for ids that can never point at a different item.

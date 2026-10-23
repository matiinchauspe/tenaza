# Runtime-free core, capability-declaring adapters

The core and the event contract carry no knowledge of any agent runtime; each runtime gets one
Adapter that declares its Capabilities, and the core degrades by Capability, never by runtime name.
Chosen over per-runtime branches in the core because runtimes genuinely differ (mid-run stop is
partial on Claude Code and absent on Cursor), and a `fake` adapter with different Capabilities keeps
the core honest in tests.

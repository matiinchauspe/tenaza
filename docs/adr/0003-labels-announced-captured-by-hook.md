# Labels are announced by the agent and captured by the hook

An agent (a subagent especially) does not know its own session id, but the runtime's hooks do; so a
caller like Yunque announces Labels by running a label command, and the Adapter's pre-tool hook
intercepts it and writes the Label to the right Session's log. Chosen over passing ids to agents or
a caller-side log, which would duplicate Tenaza as a second source of truth.

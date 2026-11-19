import { z } from "zod";

/**
 * The Live surface's own contract: the one shape `GET /events` pushes and
 * the board's client reads — reusing `event.ts`'s own style (a validated
 * zod schema, the inferred type derived from it, never hand-written in
 * parallel). Zero node-builtin imports, same as `event.ts` itself: zod is
 * isomorphic, so this module bundles straight into the browser client
 * exactly as written, with no server-only code to shim around.
 *
 * What is deliberately NOT here: any column, "stalled" or age computation.
 * Those depend on wall-clock `now`, which only the client's ticking clock
 * ever holds (the board's own `useNow` hook) — baking a column into this
 * payload would freeze it the instant a Session goes quiet (no further
 * Event, so no further push). The payload only ever carries facts that are
 * true independent of when they're read: raw timestamps, and the Policy
 * numbers (`stallMinutes`, `contextThresholdTokens`) the client's pure
 * functions (`src/board.ts`) need to turn those facts into a column —
 * sourced from the one place the Policy is read (`policy.ts`), never
 * hardcoded again on the client.
 */

export const LivePolicySchema = z.object({
  stallMinutes: z.number(),
  contextThresholdTokens: z.number(),
  /**
   * The effective (already-capped) live-answering window in seconds —
   * `policy.ts`'s `effectiveWaitSeconds`, never the raw
   * `Policy.waitSeconds` a human may have configured past the hook's own
   * ceiling. The client's draining bar (`board.ts`'s `liveItemPhase`/
   * `liveWaitRemainingFraction`) must drain over the same window the hook
   * itself actually holds for, or a generous `[live] wait_seconds` would
   * show a bar still draining long after the hook already denied and the
   * item turned pending.
   */
  waitSeconds: z.number(),
});
export type LivePolicy = z.infer<typeof LivePolicySchema>;

/**
 * A Session's own structural role — never the `ticket` Label (that
 * travels separately, below): `"sesión"` for a top-level Session,
 * `"subagente"` for one with a parent. Kept apart from `ticket` here,
 * rather than folded into one structural fallback the way `sessions.ts`'s
 * `roleOf` does for the CLI tree's single compact line.
 */
export const SessionRoleSchema = z.enum(["sesión", "subagente"]);
export type SessionRole = z.infer<typeof SessionRoleSchema>;

/**
 * The static, pre-click reach a card's own "ir a terminal ↗" / "abrir App
 * ↗" / "terminal desconocida" label is built from — `src/terminals.ts`'s
 * `reachFor`, computed server-side from the owning Session's (or, for a
 * subagent, its parent's) captured terminal locator. Never the outcome of
 * an actual click — that only ever happens live, inside the Daemon's own
 * focus route, and is never reported back over this payload at all
 * (fire-and-forget, same as every other write this board makes).
 */
export const TerminalReachSchema = z.enum(["exact", "app", "unknown"]);
export type TerminalReach = z.infer<typeof TerminalReachSchema>;

/**
 * The two `Notification` matcher values this project reads — same set as
 * `event.ts`'s own `NotificationKindSchema`, kept as its own schema here
 * (never imported from `event.ts`) so this module stays free of any
 * server-only import chain — the same discipline every other type in this
 * file follows.
 */
export const NativeWaitKindSchema = z.enum(["permission_prompt", "idle_prompt"]);
export type NativeWaitKind = z.infer<typeof NativeWaitKindSchema>;

/**
 * The shape of a Session's own plain, Stop-derived wait — `since` is
 * `sessions.ts`'s `turnWaitSince` (the Turn's own end ts), `backgroundCount`
 * is `countActiveDescendants` (0 when nothing is running in the
 * background). Kept as its own schema, separate from `NativeWaitKindSchema`
 * above, because the two are mutually exclusive by `turnWaitSince`'s own
 * gate (server-side) and the client never needs to pick between them.
 */
export const TurnWaitSchema = z.object({ since: z.string(), backgroundCount: z.number() });
export type TurnWait = z.infer<typeof TurnWaitSchema>;

/**
 * A plain summary of one Action — what the Inbox row's "tool + command"
 * field and a Session's "last signal" field both are, structurally. Kept
 * as one shared shape so a renderer only needs one "tool: command, or just
 * tool" formatter (`viewModel.ts`'s `toolLabelFor`) for both.
 */
export const ActionSummarySchema = z.object({
  kind: z.enum(["shell", "mcp"]),
  /** The runtime's own tool name (e.g. "Bash", or an MCP tool's fully-qualified name). */
  tool: z.string(),
  /** Set only for a `shell` Action — an `mcp` Action has no stored command. */
  command: z.string().optional(),
});
export type ActionSummary = z.infer<typeof ActionSummarySchema>;

/**
 * One past resolution of a request this Session raised — the resolution
 * trace's own raw material. `kind` is already resolved from the log's own
 * `approval.resolved`/`run.failed` Events (`inbox.ts`'s
 * `deriveResolutionTraceBySession`) into exactly the six the trace tells
 * apart: `ran` ("corrido por vos"), `done` ("cerrado como listo"),
 * `dismissed` ("descartado"), `failed` ("falló (código N)" — the item
 * stays open), `approved`/`rejected` (a live answer). `id` is the full
 * identity hash; `ts` is a plain fact the client formats its own age from
 * (`board.ts`'s `formatAge`), same convention as every other timestamp in
 * this contract.
 */
export const ResolutionTraceEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(["ran", "done", "dismissed", "failed", "approved", "rejected"]),
  ts: z.string(),
  /** Set only for `kind: "failed"` — the stored command's own exit code. */
  exitCode: z.number().optional(),
});
export type ResolutionTraceEntry = z.infer<typeof ResolutionTraceEntrySchema>;

/**
 * One Session's row on the board — already resolved to a project
 * (`deriveProject`, `sessions.ts`) server-side, since that shells out to
 * `git` and is never shippable to a browser bundle. Everything else here
 * is a plain fact the client's pure functions classify against a ticking
 * clock: `sessionColumn` and `formatAge` (`board.ts`, leaning on
 * `sessionstate.ts` for the state itself).
 */
export const BoardSessionSchema = z.object({
  id: z.string(),
  /** The Session that launched this one, when it has one — a card shows "↳ parent". */
  parentId: z.string().optional(),
  project: z.string(),
  /** The `ticket` Label verbatim, exactly as announced — never validated or parsed. `undefined` when never labeled. */
  ticket: z.string().optional(),
  /** The `verdict` Label verbatim, as last announced. `undefined` when never labeled. */
  verdict: z.string().optional(),
  role: SessionRoleSchema,
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  lastEventTs: z.string().optional(),
  /** Gates the context track exactly like `formatContextColumn` already does — never inferred from whether a sample happens to exist. */
  hasMeasureCapability: z.boolean(),
  contextTokens: z.number().optional(),
  /** "Last signal", distinct from the client's age column: the latest Action this Session attempted, allowed or not — `sessions.ts`'s `lastAction`. `undefined` when it has never attempted one. */
  lastSignal: ActionSummarySchema.optional(),
  /** Every past resolution of a request this Session raised, newest first — empty when it never raised one. Always present (never `undefined`) so the client never special-cases its absence. */
  resolutions: z.array(ResolutionTraceEntrySchema),
  /** This Session's own static focus reach — `"unknown"` for legacy v0.1 data, or any environment the capture recognized nothing in. */
  terminalReach: TerminalReachSchema,
  /** Set whenever `terminalReach` is "exact" or "app" — the terminal app's own display name for the "abrir <App> ↗" label. `undefined` only for "unknown". */
  terminalAppLabel: z.string().optional(),
  /** True for a row behind a macOS Automation (TCC) prompt (Terminal.app, iTerm2, Ghostty) — the card's own "macOS va a pedir permiso" note. */
  terminalNeedsTcc: z.boolean(),
  /**
   * Present while Claude Code's own permission prompt or idle turn is the
   * most recent thing observed for this Session — `since` is the
   * notification's own ts (`sessions.ts`'s `nativeWaitFor`). Never raised
   * or resolvable by Tenaza itself: no Rule matched, no Inbox item opened
   * — contrast a Session's own live request, which Tenaza did raise and
   * can answer. The client renders this as a plain, non-actionable badge
   * (no aprobar/rechazar, no draining bar) precisely because of that
   * difference. `undefined` for every Session where nothing later
   * superseded it, or where nothing was ever observed at all.
   */
  nativeWait: z.object({ kind: NativeWaitKindSchema, since: z.string() }).optional(),
  /**
   * Present while this Session's own Turn ended and nothing else has
   * happened since (`sessions.ts`'s `turnWaitSince`) — `undefined`
   * whenever a more specific `nativeWait` already covers it, or once the
   * Session itself has ended, or when no Turn has ever ended at all. The
   * client renders this as a plain, non-actionable badge, same convention
   * `nativeWait` already follows and for the same reason: Tenaza never
   * raised this and can never answer it on the agent's behalf.
   */
  turnWait: TurnWaitSchema.optional(),
});
export type BoardSession = z.infer<typeof BoardSessionSchema>;

/** One pending Inbox item's row. */
export const BoardInboxItemSchema = z.object({
  id: z.string(),
  /** The Session whose Action this is — shown on the card as its own field, distinct from "project / ticket". */
  sessionId: z.string(),
  project: z.string(),
  ticket: z.string().optional(),
  ts: z.string(),
  action: ActionSummarySchema,
  /** An enforced deny (awaiting `run`) vs. one that already ran. */
  blocked: z.boolean(),
  /**
   * The row's own raw decision — `"held"` while the hook still polls for
   * an answer, `"deny"` for a plain pending item (today's shape, or a
   * held item whose window has lapsed), `"allow"` for the unblockable
   * case. The client derives live-vs-pending from this plus `ts` and the
   * Policy's own `waitSeconds` (`board.ts`'s `liveItemPhase`).
   */
  decision: z.enum(["allow", "deny", "held"]),
  /** A pending request's own card gets the same terminal button, resolved from its owning Session (`sessionId`) exactly like `project`/`ticket` already are. */
  terminalReach: TerminalReachSchema,
  terminalAppLabel: z.string().optional(),
  terminalNeedsTcc: z.boolean(),
});
export type BoardInboxItem = z.infer<typeof BoardInboxItemSchema>;

export const BoardPayloadSchema = z.object({
  v: z.literal(1),
  policy: LivePolicySchema,
  sessions: z.array(BoardSessionSchema),
  inbox: z.array(BoardInboxItemSchema),
});
export type BoardPayload = z.infer<typeof BoardPayloadSchema>;

/**
 * Validate at the boundary: the client's `useEventSource` hook calls this
 * on every SSE frame instead of trusting `JSON.parse`'s output outright.
 * `undefined` on anything that isn't a valid `BoardPayload` — a torn
 * frame, a future server's incompatible shape — so the caller can keep
 * its last good state instead of crashing the board (never throws).
 */
export function parseBoardPayload(raw: unknown): BoardPayload | undefined {
  const result = BoardPayloadSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

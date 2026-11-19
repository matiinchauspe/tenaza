import { Column, type ColumnTone } from "./Column";
import { InboxCard } from "./InboxCard";
import { SessionCard } from "./SessionCard";
import { TE_NECESITA_TOOLTIP, type BoardViewModel } from "./viewModel";

export interface BoardProps {
  viewModel: BoardViewModel;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** Forwarded straight through to `SessionCard` as its own `highlighted` prop. */
  highlightedSessionId: string | undefined;
  /** Forwarded straight through to every `InboxCard` — `Board` itself stays pure. */
  runningIds: ReadonlySet<string>;
  outputs: Readonly<Record<string, string>>;
  errors: Readonly<Record<string, string>>;
  onRun: (id: string) => void;
  onDone: (id: string) => void;
  onDismiss: (id: string) => void;
  /** Forwarded to every `SessionCard` — only the one with its own `liveRequest` set ever actually calls either. */
  onApprove: (id: string, message: string | undefined) => void;
  onReject: (id: string, message: string | undefined) => void;
  /** Forwarded to every card, Inbox and Session alike. `id` is whatever the clicked card's own id is — `BoardApp` resolves it to the owning Session id before the write ever fires. */
  onFocusTerminal: (id: string) => void;
  /** Forwarded only to a TERMINÓ `SessionCard` — the control itself is never rendered on a CORRIENDO/TRABADA card, let alone an Inbox one. */
  onArchive: (id: string) => void;
}

const SESSION_COLUMNS = ["corriendo", "trabada", "termino"] as const;

/** The one place this copy is picked, so no column ever invents its own wording. */
const SESSION_COLUMN_META: Record<(typeof SESSION_COLUMNS)[number], { tone: ColumnTone; label: string; empty: string }> = {
  corriendo: { tone: "corriendo", label: "Corriendo", empty: "—" },
  trabada: { tone: "trabada", label: "Trabada", empty: "—" },
  termino: { tone: "termino", label: "Terminó", empty: "—" },
};

const TE_NECESITA_EMPTY = "nada te espera — los agentes siguen solos";

/** Pure presentational — `BoardApp` already classified every card into its column and resolved the current selection; this component only lays them out. */
export function Board({
  viewModel,
  selectedId,
  onSelect,
  highlightedSessionId,
  runningIds,
  outputs,
  errors,
  onRun,
  onDone,
  onDismiss,
  onApprove,
  onReject,
  onFocusTerminal,
  onArchive,
}: BoardProps) {
  return (
    <div className="board">
      <Column
        title={viewModel.teNecesita.title}
        count={viewModel.teNecesita.cards.length}
        tone="te-necesita"
        emptyMessage={TE_NECESITA_EMPTY}
        tooltip={TE_NECESITA_TOOLTIP}
      >
        {viewModel.teNecesita.cards.map((card) => (
          <InboxCard
            key={card.id}
            card={card}
            selected={card.id === selectedId}
            onSelect={onSelect}
            running={runningIds.has(card.id)}
            output={outputs[card.id]}
            errorMessage={errors[card.id]}
            onRun={onRun}
            onDone={onDone}
            onDismiss={onDismiss}
            onFocusTerminal={() => onFocusTerminal(card.sessionId)}
          />
        ))}
      </Column>
      {SESSION_COLUMNS.map((key) => {
        const column = viewModel[key];
        const meta = SESSION_COLUMN_META[key];
        return (
          <Column key={column.key} title={column.title} count={column.cards.length} tone={meta.tone} emptyMessage={meta.empty}>
            {column.cards.map((card) => (
              <SessionCard
                key={card.id}
                card={card}
                tone={meta.tone}
                statusLabel={meta.label}
                selected={card.id === selectedId}
                highlighted={card.id === highlightedSessionId}
                onSelect={onSelect}
                onApprove={onApprove}
                onReject={onReject}
                onFocusTerminal={() => onFocusTerminal(card.id)}
                // This is the one place the TERMINÓ-only gate is drawn — `SessionCard` itself
                // never needs to know which column it's rendering in.
                showArchive={key === "termino"}
                onArchive={() => onArchive(card.id)}
              />
            ))}
          </Column>
        );
      })}
    </div>
  );
}

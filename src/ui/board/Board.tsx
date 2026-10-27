import { Column, type ColumnTone } from "./Column";
import { InboxCard } from "./InboxCard";
import { SessionCard } from "./SessionCard";
import type { BoardViewModel } from "./viewModel";

export interface BoardProps {
  viewModel: BoardViewModel;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** Ticket 09: forwarded straight through to every `InboxCard` — `Board` itself stays pure, it only threads these to the one place they apply. */
  runningIds: ReadonlySet<string>;
  outputs: Readonly<Record<string, string>>;
  /** Review fix: the last non-ok, non-403 write error per item id, if any — see `InboxCard`'s own prop doc. */
  errors: Readonly<Record<string, string>>;
  onRun: (id: string) => void;
  onDone: (id: string) => void;
  onDismiss: (id: string) => void;
}

const SESSION_COLUMNS = ["corriendo", "trabada", "termino"] as const;

/** Es-AR empty-state copy, verbatim from the prototype (decision 04's human fix round) — the one place it's picked, so no column ever invents its own wording. */
const SESSION_COLUMN_META: Record<(typeof SESSION_COLUMNS)[number], { tone: ColumnTone; label: string; empty: string }> = {
  corriendo: { tone: "corriendo", label: "Corriendo", empty: "—" },
  trabada: { tone: "trabada", label: "Trabada", empty: "—" },
  termino: { tone: "termino", label: "Terminó", empty: "—" },
};

const TE_NECESITA_EMPTY = "nada te espera — los agentes siguen solos";

/**
 * The board itself (ticket 08, decision 04): TE NECESITA · CORRIENDO ·
 * TRABADA · TERMINÓ. Pure presentational — the container (`BoardApp`)
 * already classified every card into its column and resolved the current
 * selection; this component only lays them out. No fetching, no effects,
 * no global state.
 */
export function Board({
  viewModel,
  selectedId,
  onSelect,
  runningIds,
  outputs,
  errors,
  onRun,
  onDone,
  onDismiss,
}: BoardProps) {
  return (
    <div className="board">
      <Column
        title={viewModel.teNecesita.title}
        count={viewModel.teNecesita.cards.length}
        tone="te-necesita"
        emptyMessage={TE_NECESITA_EMPTY}
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
                onSelect={onSelect}
              />
            ))}
          </Column>
        );
      })}
    </div>
  );
}

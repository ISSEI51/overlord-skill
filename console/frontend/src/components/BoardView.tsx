import { useMemo, useState, type ReactNode } from "react";

import { Trash2Icon } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useConsole } from "@/console-context";
import { changeProgress, decisionId, decisionIds, decisionText, hasSession, scoreOf } from "@/lib/board";
import { deliveryTag } from "@/lib/delivery";
import { STATES, type DeliveryEvent, type Item, type StateKey } from "@/lib/types";
import { cn } from "@/lib/utils";

export function BoardView() {
  const { data, selectedId, select, moveItem, deleteItem, deliveries } = useConsole();
  const items = data.board.items ?? [];
  const needsUserIds = useMemo(() => decisionIds(data.board), [data.board]);
  const decisions = (data.board.decisions_required ?? []).slice(0, 3);
  const [dropTarget, setDropTarget] = useState<StateKey | null>(null);

  return (
    <>
      {decisions.length > 0 && (
        <section className="shrink-0 border-b bg-warn/10 px-4 py-2.5">
          <h2 className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-warn">
            今日の判断
          </h2>
          <div className="flex flex-wrap gap-2">
            {decisions.map((entry, index) => {
              const id = decisionId(entry);
              return (
                <div
                  key={index}
                  className={cn(
                    "rounded-lg border border-warn/35 bg-card px-2.5 py-1.5 text-xs",
                    id && "cursor-pointer hover:border-warn",
                  )}
                  title={id ? `${id} を開く` : undefined}
                  onClick={id ? () => select(id) : undefined}
                >
                  {decisionText(entry)}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <main className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto overflow-y-hidden px-4 py-3">
        {STATES.map((state) => {
          const columnItems = items.filter((item) => item.state === state.key);
          const overLimit = state.key === "implementing" && columnItems.length > 3;
          return (
            <section
              key={state.key}
              className={cn(
                "flex w-[216px] shrink-0 flex-col overflow-hidden rounded-lg border bg-sunken",
                dropTarget === state.key && "border-primary",
              )}
              onDragOver={(event) => {
                event.preventDefault();
                setDropTarget(state.key);
              }}
              onDragLeave={() =>
                setDropTarget((previous) => (previous === state.key ? null : previous))
              }
              onDrop={(event) => {
                event.preventDefault();
                setDropTarget(null);
                const id = event.dataTransfer.getData("text/plain");
                const item = items.find((entry) => entry.id === id);
                if (!item || item.state === state.key) return;
                void moveItem(id, state.key, state.label);
              }}
            >
              <div
                className={cn(
                  "flex items-center justify-between border-b px-2.5 py-2 text-xs font-semibold text-dim",
                  overLimit && "text-warn",
                )}
              >
                <span>{state.label}</span>
                <span className="font-normal text-faint">{columnItems.length}</span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                {columnItems.map((item) => {
                  // Done/blocked cards never get the needs-user highlight,
                  // even if owner === "user" or a decision entry still
                  // references them (mirrors the exclusion on `running`).
                  const needsUser =
                    item.state !== "done" &&
                    item.state !== "blocked" &&
                    (item.state === "acceptance" ||
                      item.owner === "user" ||
                      needsUserIds.has(item.id));
                  // AI is actively working on the card. The needs-user
                  // highlight wins when both apply.
                  const running =
                    !needsUser &&
                    item.owner === "claude" &&
                    item.state !== "done" &&
                    item.state !== "blocked";
                  return (
                    <BoardCard
                      key={item.id}
                      item={item}
                      needsUser={needsUser}
                      running={running}
                      delivery={deliveries[item.id] ?? null}
                      selected={item.id === selectedId}
                      onSelect={() => select(item.id)}
                      // Only done cards get a context menu; the server also
                      // rejects deleting anything else with a 400.
                      onDelete={
                        item.state === "done" ? () => void deleteItem(item.id) : undefined
                      }
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </main>
    </>
  );
}

function BoardCard({
  item,
  needsUser,
  running,
  delivery,
  selected,
  onSelect,
  onDelete,
}: {
  item: Item;
  needsUser: boolean;
  running: boolean;
  /** The delivery frame seen for this card this session, if any. */
  delivery: DeliveryEvent | null;
  selected: boolean;
  onSelect: () => void;
  /** Present only on done cards; enables the right-click delete menu. */
  onDelete?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const score = scoreOf(item);
  const session = hasSession(item);
  // Read-only progress of the card's engineering split; changes never
  // become cards of their own.
  const progress = changeProgress(item);
  // The delivery of an accepted card, so that a run in flight and a failed
  // one are visible without opening the card and after the toast is gone.
  const shipping = deliveryTag(item, delivery);
  const card = (
    <article
      draggable
      onClick={onSelect}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", item.id);
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        "cursor-pointer rounded-md border bg-card px-2 py-2 hover:border-line-strong",
        needsUser && "border-needs-user hover:border-needs-user",
        running && "border-running hover:border-running",
        selected && "border-primary hover:border-primary",
        selected && needsUser && "ring-2 ring-needs-user/55",
        selected && running && "ring-2 ring-running/55",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="font-mono text-[10px] text-faint">{item.id}</span>
        {score !== null && <span className="font-mono text-[10px] text-dim">{score}</span>}
      </div>
      <h3 className="mt-0.5 text-[12.5px] leading-snug font-medium">{item.title ?? ""}</h3>
      {item.next_action && (
        <div className="mt-1 text-[11px] text-dim">→ {item.next_action}</div>
      )}
      {(item.project || item.owner || session || progress || shipping || item.blocker) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.project && <CardTag>{item.project}</CardTag>}
          {item.owner && <CardTag>{item.owner}</CardTag>}
          {session && <CardTag className="border-primary/40 text-primary">担当あり</CardTag>}
          {progress && (
            <CardTag>
              変更 {progress.done}/{progress.total}
            </CardTag>
          )}
          {shipping && (
            <CardTag
              className={cn(
                shipping.tone === "running" && "border-running/40 text-running",
                shipping.tone === "failed" && "border-destructive/40 text-destructive",
                shipping.tone === "pr" && "border-primary/40 text-primary",
              )}
            >
              {shipping.label}
            </CardTag>
          )}
          {item.blocker && (
            <CardTag className="border-destructive/40 text-destructive">停止中</CardTag>
          )}
        </div>
      )}
    </article>
  );
  if (!onDelete) return card;
  // The trigger only adds an onContextMenu handler to the article, so
  // click-to-open and drag-and-drop behave exactly as without the menu.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2Icon />
          削除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CardTag({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full border bg-sunken px-1.5 py-px text-[10px] text-faint",
        className,
      )}
    >
      {children}
    </span>
  );
}

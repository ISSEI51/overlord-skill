import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useConsole } from "@/console-context";
import { errorMessage } from "@/lib/api";
import {
  activeSession,
  cardActivity,
  changesOf,
  decisionIds,
  formatValue,
  stateLabel,
  surfaceLabel,
  terminalSurfaces,
} from "@/lib/board";
import {
  deliveryStatusText,
  deliveryView,
  prLabel,
  safePrUrl,
  skippedReasonText,
} from "@/lib/delivery";
import { cardInstructions } from "@/lib/templates";
import { STATES, type Change, type Item } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Card detail as a centered modal dialog. Closing (outside click or
 * Escape; there is no corner close button) only clears the selection;
 * Escape inside an editable field is stopped there and never reaches
 * the dialog.
 */
export function DetailPanel() {
  const { data, selectedId, select } = useConsole();
  const item = (data.board.items ?? []).find((entry) => entry.id === selectedId) ?? null;

  return (
    <Dialog
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open) select(null);
      }}
    >
      {item && (
        <DialogContent
          className="flex max-h-[85vh] w-full flex-col gap-0 overflow-hidden rounded-2xl border-line-strong p-0 shadow-2xl sm:max-w-2xl"
          showCloseButton={false}
          aria-describedby={undefined}
          onPointerDownOutside={() => {
            // Commit a pending edit before the dialog unmounts: blur the
            // focused field explicitly so its blur handler runs first.
            const active = document.activeElement;
            if (active instanceof HTMLElement) active.blur();
          }}
        >
          <DialogHeader className="shrink-0 gap-0.5 px-4 pt-4 pb-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] text-faint">
                  {[item.id, item.project].filter(Boolean).join("  ·  ")}
                </div>
                <DialogTitle className="text-[15px] leading-snug">
                  {item.title ?? ""}
                </DialogTitle>
              </div>
              {item.state === "acceptance" && <AcceptDoneButton item={item} />}
            </div>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <CommandField item={item} />
            <InstructionField key={item.id} item={item} />
            <StateField item={item} />
            <EditableField key={`${item.id}:next_action`} item={item} field="next_action" label="次にすること" />
            <EditableField key={`${item.id}:owner`} item={item} field="owner" label="担当" />
            <EditableField key={`${item.id}:blocker`} item={item} field="blocker" label="止まっている理由" />
            <WorkerField item={item} />
            <ChangesField item={item} />
            <DeliveryField key={`${item.id}:delivery`} item={item} />
            <ReadonlyField label="困っていることと根拠" value={item.evidence} />
            <ConditionsField item={item} />
            <ReadonlyField label="今回はやらないこと" value={item.out_of_scope} />
            {Boolean(item.brief) && (
              <ReadonlyField label="実装前メモ" value={formatValue(item.brief)} />
            )}
            {Boolean(item.review) && (
              <ReadonlyField label="確認結果" value={formatValue(item.review)} />
            )}
            <Field label="更新">
              <div className="text-[12.5px] text-faint">{item.updated_at ?? "-"}</div>
            </Field>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * Accept-and-complete for cards awaiting acceptance (state === "acceptance"
 * only; the caller guards rendering). One PATCH sets state to done and
 * clears owner / next_action / blocker, then closes the modal. On failure
 * (e.g. 409 rev conflict) it matches patchField's behavior: error toast and
 * board reload, with the modal left open.
 */
function AcceptDoneButton({ item }: { item: Item }) {
  const { patchItem, load, select } = useConsole();
  const [saving, setSaving] = useState(false);

  const complete = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await patchItem(item.id, {
        state: "done",
        owner: null,
        next_action: null,
        blocker: null,
      });
      toast.success(`${item.id} を完了にしました`);
      select(null);
    } catch (error) {
      toast.error(`更新できません: ${errorMessage(error)}`);
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button size="sm" className="shrink-0" disabled={saving} onClick={() => void complete()}>
      受け入れて完了
    </Button>
  );
}

/**
 * Fixed card actions: one press sends directly to the commander.
 * sendTemplate carries the in-flight guard, the not-connected error toast,
 * and the success toast.
 *
 * A button an unfinished worker session rules out (today only 進める) is
 * disabled and the reason is printed under the row, so the card says why it
 * cannot be pushed forward instead of accepting a press that changes nothing.
 */
function CommandField({ item }: { item: Item }) {
  const { data, sendTemplate } = useConsole();
  const templates = cardInstructions(item, cardActivity(item, decisionIds(data.board)));
  const blocked = templates.find((template) => template.blocked)?.blocked ?? null;
  return (
    <Field label="司令塔への指示">
      <div className="flex flex-wrap gap-1.5">
        {templates.map((template) => (
          <Button
            key={template.label}
            variant="outline"
            size="xs"
            disabled={Boolean(template.blocked)}
            title={template.blocked ?? undefined}
            onClick={() => void sendTemplate(template.text)}
          >
            {template.label}
          </Button>
        ))}
      </div>
      {blocked && <div className="mt-1.5 text-[11px] text-running">{blocked}</div>}
      <div className="mt-1.5 text-[11px] text-faint">
        ボタンは司令塔へ直接送信します。
      </div>
    </Field>
  );
}

/**
 * Free-form instruction for this card. The card id is prefixed to the
 * text before sending; a successful send clears the field. Cmd/Ctrl+Enter
 * sends, plain Enter only inserts a newline.
 */
function InstructionField({ item }: { item: Item }) {
  const { sendTemplate } = useConsole();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const trimmed = text.trim();
    if (trimmed === "" || sending) return;
    setSending(true);
    try {
      const sent = await sendTemplate(`${item.id} ${trimmed}`);
      if (sent) setText("");
    } finally {
      setSending(false);
    }
  };

  return (
    <Field label="このカードへの詳細指示">
      <Textarea
        value={text}
        rows={3}
        placeholder={`${item.id} に付けて司令塔へ送る指示を書く`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
          if (event.key === "Escape") {
            // Leave the field without closing the dialog or losing the draft.
            event.stopPropagation();
            event.currentTarget.blur();
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <Button
          size="xs"
          disabled={text.trim() === "" || sending}
          onClick={() => void send()}
        >
          送信
        </Button>
        <div className="text-[11px] text-faint">⌘/Ctrl+Enter でも送信できます。</div>
      </div>
    </Field>
  );
}

function StateField({ item }: { item: Item }) {
  const { patchField } = useConsole();
  return (
    <Field label="状態">
      <Select
        value={item.state}
        onValueChange={(value) => void patchField(item.id, { state: value })}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATES.map((state) => (
            <SelectItem key={state.key} value={state.key}>
              {state.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * Blur commits, Enter confirms (via blur), Escape restores the original
 * value and never saves. stopPropagation on Escape keeps the dialog open.
 * External board updates only sync in while the field is not focused, so
 * typing is never lost to a re-render.
 */
function EditableField({
  item,
  field,
  label,
}: {
  item: Item;
  field: "next_action" | "owner" | "blocker";
  label: string;
}) {
  const { patchField } = useConsole();
  const original = item[field] ?? "";
  const [value, setValue] = useState<string>(original);
  const [focused, setFocused] = useState(false);
  const cancelRef = useRef(false);

  /* Sync external board changes in, but never while the field is focused. */
  const lastOriginal = useRef(original);
  useEffect(() => {
    if (original === lastOriginal.current) return;
    lastOriginal.current = original;
    if (!focused) setValue(original);
  }, [original, focused]);

  return (
    <Field label={label}>
      <Input
        value={value}
        placeholder="—"
        className="h-8"
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (cancelRef.current) {
            cancelRef.current = false;
            return;
          }
          const next = value.trim() === "" ? null : value;
          if ((item[field] ?? null) === next) return;
          void patchField(item.id, { [field]: next });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            // Cancel, don't save: restore the original value and keep the
            // dialog open (neither Radix nor the global Escape handler
            // sees this event).
            event.stopPropagation();
            cancelRef.current = true;
            setValue(original);
            event.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}

/** Read-only view of the worker session the commander assigned to this card. */
function WorkerField({ item }: { item: Item }) {
  const { data, focusSurface } = useConsole();
  // A change owns its agent; the card-level agent is the fallback.
  const session = activeSession(item);
  const surfaceId = session?.agent.surface_id ?? null;
  const link = surfaceId
    ? (terminalSurfaces(data).find((entry) => entry.surface.id === surfaceId) ?? null)
    : null;

  return (
    <Field label={session?.changeId ? `担当セッション（${session.changeId}）` : "担当セッション"}>
      {!surfaceId ? (
        <div className="text-[12.5px] text-faint">未割り当て（司令塔が起動します）</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 text-[12.5px]">
              {link ? surfaceLabel(link) : "記録されたセッションは見つかりません（終了済み）"}
            </div>
            {link && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  focusSurface(link).catch((error) =>
                    toast.error(`開けません: ${errorMessage(error)}`),
                  );
                }}
              >
                cmux で開く
              </Button>
            )}
          </div>
          {session?.agent.cwd && (
            <div className="mt-1 text-[11px] text-faint">{session.agent.cwd}</div>
          )}
        </>
      )}
    </Field>
  );
}

/**
 * Read-only engineering split of the card. Changes are not a human decision
 * unit, so nothing here is editable: the board stays one card per outcome.
 */
function ChangesField({ item }: { item: Item }) {
  const changes = changesOf(item);
  if (changes.length === 0) return null;
  return (
    <Field label="変更（PR単位）">
      <ul className="flex flex-col gap-1.5">
        {changes.map((change) => (
          <li key={change.id} className="rounded-md border bg-sunken px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-[10px] text-faint">{change.id}</span>
              <span className="text-[10px] text-dim">{stateLabel(change.state)}</span>
            </div>
            <div className="text-[12.5px] leading-snug">{change.title ?? ""}</div>
            <ChangeLinks change={change} />
          </li>
        ))}
      </ul>
    </Field>
  );
}

function ChangeLinks({ change }: { change: Change }) {
  const url = change.pr?.url ?? null;
  // Only render an anchor for a real https URL; the file is agent-written.
  const safeUrl = url && url.startsWith("https://") ? url : null;
  const label = change.pr?.number ? `PR #${change.pr.number}` : url ? "PR" : null;
  const prState = change.pr?.state ?? null;
  if (!change.branch && !label) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-faint">
      {change.branch && <span>{change.branch}</span>}
      {label &&
        (safeUrl ? (
          <a
            href={safeUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            {label}
          </a>
        ) : (
          <span>{label}</span>
        ))}
      {prState && <span>({prState})</span>}
    </div>
  );
}

/**
 * Where this card's finished work was proposed, and what the last attempt to
 * propose it did.
 *
 * Two sources, shown separately because they are not the same thing:
 *
 *   - the run this browser watched (`deliveries`), which is the only place a
 *     `running`, `skipped` or `blocked` outcome is kept: none of the three
 *     writes a delivery record;
 *   - `items[].delivery`, the record that outlives the session and the toast.
 *     It holds the delivery pull request and, after a failure, its reason.
 *
 * The card is rendered without either only when neither exists, which is
 * every card that was never delivered.
 */
function DeliveryField({ item }: { item: Item }) {
  const { deliveries, deliverItem } = useConsole();
  const [retrying, setRetrying] = useState(false);
  /** A refusal of the request itself, e.g. a server started --no-deliver. */
  const [refused, setRefused] = useState<string | null>(null);
  const view = deliveryView(item, deliveries[item.id]);
  if (!view) return null;

  const live = view.live;
  const url = safePrUrl(view.pr);
  const number = prLabel(view.pr);
  const prText = number ? `成果PR ${number}` : "成果PR";
  const prState = view.pr?.state ?? null;
  // The server writes the reason of a failed run to `delivery.error`, so the
  // watched failure and the recorded one are the same sentence twice.
  const recordedError =
    live?.status === "failed" && live.reason === view.error ? null : view.error;

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRefused(null);
    try {
      await deliverItem(item.id);
    } catch (error) {
      // Never swallowed: a 409 here means this server does not deliver at
      // all, and the user would otherwise wait for a frame that never comes.
      const message = errorMessage(error);
      setRefused(message);
      toast.error(`配送を実行できません: ${message}`);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Field label="成果の配送">
      {live && (
        <div className="mb-1.5 text-[12.5px]">
          <span
            className={cn(
              live.status === "failed" && "text-destructive",
              live.status === "blocked" && "text-warn",
            )}
          >
            {deliveryStatusText(live.status)}
            {live.status === "skipped" && `（${skippedReasonText(live.reason)}）`}
            {live.status === "failed" && live.reason && `: ${live.reason}`}
          </span>
          {live.status === "blocked" && (live.unmerged?.length ?? 0) > 0 && (
            <ul className="mt-1 font-mono text-[11px] text-dim">
              {live.unmerged?.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          )}
          {(live.warnings?.length ?? 0) > 0 && (
            <ul className="mt-1 text-[11px] text-warn">
              {live.warnings?.map((warning) => (
                <li key={warning}>警告: {warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view.pr ? (
        <div className="text-[12.5px]">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {prText}
            </a>
          ) : (
            <span>{prText}</span>
          )}
          {prState && <span className="ml-1.5 text-[11px] text-dim">({prState})</span>}
        </div>
      ) : (
        !live && <div className="text-[12.5px] text-faint">成果PRはまだありません</div>
      )}

      {(view.branch || view.base) && (
        <div className="mt-0.5 font-mono text-[10px] text-faint">
          {[view.branch, view.base].filter(Boolean).join(" → ")}
        </div>
      )}

      {recordedError && (
        <div className="mt-1 text-[12.5px] text-destructive">
          記録された失敗: {recordedError}
        </div>
      )}

      {view.attemptedAt && (
        <div className="mt-0.5 text-[11px] text-faint">最終試行 {view.attemptedAt}</div>
      )}

      {view.needsRetry && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            disabled={retrying || view.running}
            onClick={() => void retry()}
          >
            配送をやり直す
          </Button>
          <div className="text-[11px] text-faint">
            {live?.status === "blocked"
              ? "未マージの変更を merge してから実行してください。"
              : "同じ配送をもう一度実行します。"}
          </div>
        </div>
      )}

      {refused && (
        <div className="mt-1 text-[12.5px] text-destructive">
          配送を実行できません: {refused}
        </div>
      )}
    </Field>
  );
}

function ConditionsField({ item }: { item: Item }) {
  const conditions = item.acceptance_conditions ?? [];
  return (
    <Field label="完成の条件">
      {conditions.length === 0 ? (
        <div className="text-[12.5px] text-faint">—</div>
      ) : (
        <ul className="list-disc pl-4.5 text-[12.5px]">
          {conditions.map((condition, index) => (
            <li key={index}>{condition}</li>
          ))}
        </ul>
      )}
    </Field>
  );
}

function ReadonlyField({ label, value }: { label: string; value?: string | null }) {
  return (
    <Field label={label}>
      {value ? (
        <div className="text-[12.5px] whitespace-pre-wrap">{value}</div>
      ) : (
        <div className="text-[12.5px] text-faint">—</div>
      )}
    </Field>
  );
}

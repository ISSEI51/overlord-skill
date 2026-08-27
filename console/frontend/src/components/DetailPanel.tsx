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
import { formatValue, surfaceLabel, terminalSurfaces } from "@/lib/board";
import { cardInstructions } from "@/lib/templates";
import { STATES, type Item } from "@/lib/types";

/**
 * Card detail as a centered modal dialog. Closing (outside click, Escape,
 * or the corner button) only clears the selection; Escape inside an
 * editable field is stopped there and never reaches the dialog.
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
          className="flex max-h-[85vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
          aria-describedby={undefined}
          onPointerDownOutside={() => {
            // Commit a pending edit before the dialog unmounts: blur the
            // focused field explicitly so its blur handler runs first.
            const active = document.activeElement;
            if (active instanceof HTMLElement) active.blur();
          }}
        >
          <DialogHeader className="shrink-0 gap-0.5 px-4 pt-4 pr-12 pb-2">
            <div className="font-mono text-[11px] text-faint">
              {[item.id, item.project].filter(Boolean).join("  ·  ")}
            </div>
            <DialogTitle className="text-[15px] leading-snug">
              {item.title ?? ""}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <CommandField item={item} />
            <InstructionField key={item.id} item={item} />
            <StateField item={item} />
            <EditableField key={`${item.id}:next_action`} item={item} field="next_action" label="次にすること" />
            <EditableField key={`${item.id}:owner`} item={item} field="owner" label="担当" />
            <EditableField key={`${item.id}:blocker`} item={item} field="blocker" label="止まっている理由" />
            <WorkerField item={item} />
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
 * Fixed card actions: one press sends directly to the commander.
 * sendTemplate carries the in-flight guard, the not-connected error toast,
 * and the success toast.
 */
function CommandField({ item }: { item: Item }) {
  const { sendTemplate } = useConsole();
  return (
    <Field label="司令塔への指示">
      <div className="flex flex-wrap gap-1.5">
        {cardInstructions(item).map((template) => (
          <Button
            key={template.label}
            variant="outline"
            size="xs"
            onClick={() => void sendTemplate(template.text)}
          >
            {template.label}
          </Button>
        ))}
      </div>
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
  const surfaceId = item.agent?.surface_id ?? null;
  const link = surfaceId
    ? (terminalSurfaces(data).find((entry) => entry.surface.id === surfaceId) ?? null)
    : null;

  return (
    <Field label="担当セッション">
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
          {item.agent?.cwd && (
            <div className="mt-1 text-[11px] text-faint">{item.agent.cwd}</div>
          )}
        </>
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

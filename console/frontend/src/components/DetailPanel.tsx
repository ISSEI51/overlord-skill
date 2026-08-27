import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConsole } from "@/console-context";
import { errorMessage } from "@/lib/api";
import { formatValue, surfaceLabel, terminalSurfaces } from "@/lib/board";
import { cardInstructions } from "@/lib/templates";
import { STATES, type Item } from "@/lib/types";
import { cn } from "@/lib/utils";

export function DetailPanel() {
  const { data, selectedId, select } = useConsole();
  const item = (data.board.items ?? []).find((entry) => entry.id === selectedId) ?? null;
  if (!item) return null;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[min(520px,88%)] flex-col border-l border-line-strong bg-card shadow-[-18px_0_40px_rgba(0,0,0,0.35)]">
      <div className="flex items-start justify-between gap-3 px-3.5 pt-3 pb-2">
        <div className="min-w-0">
          <div className="font-mono text-[11px] text-faint">
            {[item.id, item.project].filter(Boolean).join("  ·  ")}
          </div>
          <h2 className="mt-0.5 text-[15px] font-semibold">{item.title ?? ""}</h2>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="閉じる" onClick={() => select(null)}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <CommandField key={item.id} item={item} />
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
    </aside>
  );
}

/**
 * Card actions send directly to the commander. A second press of the same
 * button within three seconds confirms; at most one button is armed at a
 * time. Keyed by item id, so switching cards resets every button.
 */
function CommandField({ item }: { item: Item }) {
  const { link, sendTemplate } = useConsole();
  const [armed, setArmed] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const disarm = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(null);
  };
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <Field label="司令塔への指示">
      <div className="flex flex-wrap gap-1.5">
        {cardInstructions(item).map((template) => (
          <Button
            key={template.label}
            variant="outline"
            size="xs"
            className={cn(
              armed === template.label &&
                "border-destructive text-destructive hover:text-destructive",
            )}
            onClick={() => {
              if (armed === template.label) {
                disarm();
                void sendTemplate(template.text);
                return;
              }
              // Switching buttons never sends; it only moves the armed state.
              disarm();
              if (!link) {
                toast.error("先に司令塔を設定してください");
                return;
              }
              setArmed(template.label);
              timerRef.current = window.setTimeout(() => {
                timerRef.current = null;
                setArmed(null);
              }, 3000);
            }}
          >
            {armed === template.label ? "もう一度で送信" : template.label}
          </Button>
        ))}
      </div>
      <div className="mt-1.5 text-[11px] text-faint">
        ボタンは司令塔へ直接送信します。同じボタンをもう一度押すと送信されます。
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
 * value and never saves. External board updates only sync in while the
 * field is not focused, so typing is never lost to a re-render.
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
            // panel open (the global Escape handler never sees this event).
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

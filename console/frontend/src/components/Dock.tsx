import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { Textarea } from "@/components/ui/textarea";
import { useConsole } from "@/console-context";
import { api, errorMessage } from "@/lib/api";
import { surfaceLabel, terminalSurfaces } from "@/lib/board";
import { screenRefresh } from "@/lib/screen";
import { dockTemplates } from "@/lib/templates";
import { cn } from "@/lib/utils";

const SCREEN_INTERVAL_MS = 1500;
/** Lines fetched for the one-shot scrollback view (mode: "history"). */
const HISTORY_LINES = 2000;

/** The commander dock, built on the shadcn Sidebar (side="right", offcanvas). */
export function CommanderSidebar() {
  const {
    link,
    configured,
    ready,
    screenVisible,
    setupOpen,
    closeSetup,
    openSetup,
    focusSurface,
  } = useConsole();

  return (
    <Sidebar side="right" collapsible="offcanvas">
      <DockResizeHandle />
      <SidebarHeader className="flex-row items-center justify-between gap-2.5 border-b px-3 py-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-xs font-semibold">司令塔</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">
            {link
              ? surfaceLabel(link)
              : configured
                ? "記録されたセッションが見つかりません"
                : "未設定"}
          </span>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {ready && link && (
            <>
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  focusSurface(link).catch((error) => toast.error(errorMessage(error)))
                }
              >
                cmux で開く
              </Button>
              <Button variant="outline" size="xs" onClick={openSetup}>
                変更
              </Button>
            </>
          )}
          {!ready && setupOpen && configured && (
            <Button variant="outline" size="xs" onClick={closeSetup}>
              戻る
            </Button>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-0 overflow-hidden">
        {screenVisible && link && <ScreenMirror surfaceId={link.surface.id} />}
      </SidebarContent>

      <SidebarFooter className="border-t px-3 py-2.5">
        {ready ? <Compose /> : <Setup />}
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * Drag handle on the dock's left edge. The width lives in app state as the
 * Sidebar's --sidebar-width and persists to overlord.dockWidth (min 360px,
 * max 70vw), exactly like the old resizer.
 */
function DockResizeHandle() {
  const { dockResize } = useConsole();
  return (
    <div
      title="幅を変える"
      className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize hover:bg-primary/60 active:bg-primary"
      onMouseDown={(event) => {
        event.preventDefault();
        dockResize.setResizing(true);
        const move = (moveEvent: MouseEvent) =>
          dockResize.setWidth(window.innerWidth - moveEvent.clientX);
        const up = () => {
          dockResize.setResizing(false);
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      }}
    />
  );
}

/**
 * Terminal mirror of the commander session.
 *
 * mode: "live" (default) polls every 1.5 seconds while mounted (only when
 * the tab is visible) and follows the tail; unmounting (screenVisible
 * false) stops the polling entirely. mode: "history" fetches the
 * scrollback once (HISTORY_LINES lines) and freezes all DOM updates so
 * the reader can scroll upward without the view jumping.
 */
function ScreenMirror({ surfaceId }: { surfaceId: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [mode, setMode] = useState<"live" | "history">("live");
  const [historyLoading, setHistoryLoading] = useState(false);
  const modeRef = useRef<"live" | "history">("live");
  const liveRefreshRef = useRef<((follow?: boolean) => Promise<void>) | null>(null);
  // Bumped whenever the surface changes, so an in-flight history fetch for
  // an old surface never lands on the new one.
  const generationRef = useRef(0);

  const switchMode = (next: "live" | "history") => {
    modeRef.current = next;
    setMode(next);
  };

  useEffect(() => {
    let stopped = false;
    generationRef.current += 1;
    // A (new) surface always starts out live.
    modeRef.current = "live";
    setMode("live");
    setHistoryLoading(false);

    /**
     * Live refresh. The mode is checked both on entry and again after the
     * fetch resolves, before any DOM write — so no update path (polling
     * interval, post-send nudge, or a response that resolves late) can
     * touch the DOM or move the scroll position while history is shown.
     */
    const refresh = async (follow = false) => {
      if (modeRef.current !== "live") return;
      let text = "";
      let error: string | null = null;
      try {
        const result = await api<{ text: string }>(
          `/api/cmux/screen?surface=${encodeURIComponent(surfaceId)}&lines=120`,
        );
        text = result.text;
      } catch (cause) {
        error = `画面を読めません: ${errorMessage(cause)}`;
      }
      if (stopped || modeRef.current !== "live") return;
      const element = preRef.current;
      if (!element) return;
      const atBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      element.textContent = error ?? text;
      element.classList.toggle("opacity-55", Boolean(error));
      if (follow || atBottom) element.scrollTop = element.scrollHeight;
    };
    liveRefreshRef.current = refresh;
    // The post-send nudge funnels through the same guarded refresh, so it
    // is a no-op while history is shown.
    screenRefresh.current = () => void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, SCREEN_INTERVAL_MS);
    void refresh();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      screenRefresh.current = null;
      liveRefreshRef.current = null;
    };
  }, [surfaceId]);

  /**
   * One-shot scrollback fetch. Only the trigger button is disabled while
   * loading; the rest of the dock (compose, keys) stays usable. On
   * failure the mirror still enters history mode showing the usual
   * 「画面を読めません: …」 text, and 「追従を再開」 recovers.
   */
  const showHistory = async () => {
    if (historyLoading || modeRef.current === "history") return;
    const generation = generationRef.current;
    setHistoryLoading(true);
    let text = "";
    let error: string | null = null;
    try {
      const result = await api<{ text: string }>(
        `/api/cmux/screen?surface=${encodeURIComponent(surfaceId)}&lines=${HISTORY_LINES}&scrollback=1`,
      );
      text = result.text;
    } catch (cause) {
      error = `画面を読めません: ${errorMessage(cause)}`;
    }
    if (generation !== generationRef.current) return;
    setHistoryLoading(false);
    switchMode("history");
    const element = preRef.current;
    if (!element) return;
    element.textContent = error ?? text;
    element.classList.toggle("opacity-55", Boolean(error));
    // Land on the tail; from here the reader scrolls upward freely.
    element.scrollTop = element.scrollHeight;
  };

  /** Back to live: refresh immediately and jump to the tail. */
  const resumeLive = () => {
    switchMode("live");
    void liveRefreshRef.current?.(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-2 border-b px-2 py-1">
        {mode === "live" ? (
          <Button
            variant="outline"
            size="xs"
            disabled={historyLoading}
            onClick={() => void showHistory()}
          >
            {historyLoading ? "取得中…" : "過去の出力を読む"}
          </Button>
        ) : (
          <>
            <span className="mr-auto text-[11px] text-faint">更新を停止中</span>
            <Button variant="outline" size="xs" onClick={resumeLive}>
              追従を再開
            </Button>
          </>
        )}
      </div>
      <pre
        ref={preRef}
        className="m-0 min-h-0 flex-1 overflow-auto bg-sunken p-2.5 font-mono text-[11.5px] leading-[1.45] whitespace-pre text-dim"
      />
    </div>
  );
}

/** Commander setup: pick an existing cmux session or launch a new one. */
function Setup() {
  const { data, load, setCommander, startCommanderWorkspace } = useConsole();
  const [selected, setSelected] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [cwd, setCwd] = useState(data.projectRoot);

  if (!data.cmux.available) {
    return (
      <div className="rounded-md border border-destructive/40 bg-sunken px-2.5 py-2 text-xs text-destructive">
        {data.cmux.error ??
          "cmux に接続できません。cmux アプリが起動しているか確認してください。"}
      </div>
    );
  }

  const surfaces = terminalSurfaces(data);

  return (
    <Field label="司令塔にするセッション" className="mb-0">
      <Select value={selected || undefined} onValueChange={setSelected}>
        <SelectTrigger size="sm" className="w-full">
          <SelectValue placeholder="選んでください" />
        </SelectTrigger>
        <SelectContent>
          {data.cmux.workspaces.map((workspace) => {
            const terminals = workspace.surfaces.filter(
              (surface) => surface.type === "terminal",
            );
            if (terminals.length === 0) return null;
            return (
              <SelectGroup key={workspace.id}>
                <SelectLabel>{workspace.title || workspace.ref}</SelectLabel>
                {terminals.map((surface) => (
                  <SelectItem
                    key={surface.id}
                    value={surface.id}
                    title={workspace.latestMessage ?? ""}
                  >
                    {surface.title || surface.ref}
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })}
        </SelectContent>
      </Select>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={async () => {
            const entry = surfaces.find(
              (candidate) => candidate.surface.id === selected,
            );
            if (!entry) {
              toast.error("セッションを選んでください");
              return;
            }
            try {
              await setCommander({
                workspace_id: entry.workspace.id,
                surface_id: entry.surface.id,
                cwd: entry.workspace.cwd ?? null,
              });
              toast.success("司令塔を設定しました");
            } catch (error) {
              toast.error(`設定できません: ${errorMessage(error)}`);
            }
          }}
        >
          このセッションを司令塔にする
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
          司令塔を新しく起動
        </Button>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          一覧を更新
        </Button>
      </div>

      {createOpen && (
        <div className="mt-2 flex items-center gap-1.5">
          <Input
            value={cwd}
            autoFocus
            placeholder="司令塔を動かすディレクトリ"
            className="h-8 flex-1"
            onChange={(event) => setCwd(event.target.value)}
          />
          <Button
            size="sm"
            onClick={() => {
              const trimmed = cwd.trim();
              if (trimmed === "") {
                toast.error("ディレクトリを入力してください");
                return;
              }
              void startCommanderWorkspace(trimmed);
            }}
          >
            起動
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
            キャンセル
          </Button>
        </div>
      )}

      <div className="mt-2 text-[11px] text-faint">
        司令塔は1つだけです。各カードの作業は司令塔がサブエージェントを起動して進めます。
      </div>
    </Field>
  );
}

/**
 * Compose area: template buttons, the inline note form, and the free-form
 * draft. The draft lives in app state, so it survives every re-render;
 * template sends never touch it.
 */
function Compose() {
  const { draft, setDraft, sendCompose, sendKey, sendTemplate, composeRef } =
    useConsole();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const notePrefixRef = useRef("");
  const noteInputRef = useRef<HTMLInputElement>(null);

  const [interruptArmed, setInterruptArmed] = useState(false);
  const interruptTimer = useRef<number | null>(null);
  const disarmInterrupt = () => {
    if (interruptTimer.current !== null) window.clearTimeout(interruptTimer.current);
    interruptTimer.current = null;
    setInterruptArmed(false);
  };
  useEffect(
    () => () => {
      if (interruptTimer.current !== null) window.clearTimeout(interruptTimer.current);
    },
    [],
  );

  const submitNote = async () => {
    const trimmed = note.trim();
    if (trimmed === "") return;
    // The skill command prefix is only part of the send payload; it never
    // appears in the input or anywhere in the DOM.
    const sent = await sendTemplate(notePrefixRef.current + trimmed);
    if (!sent) return;
    setNote("");
    setNoteOpen(false);
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {dockTemplates().map((template) => (
          <Button
            key={template.label}
            variant="outline"
            size="xs"
            onClick={() => {
              if (template.inline) {
                notePrefixRef.current = template.prefix;
                setNoteOpen((previous) => {
                  const next = !previous;
                  if (next) requestAnimationFrame(() => noteInputRef.current?.focus());
                  return next;
                });
              } else {
                void sendTemplate(template.text);
              }
            }}
          >
            {template.label}
          </Button>
        ))}
      </div>

      {noteOpen && (
        <div className="mb-2 flex items-center gap-1.5">
          <Input
            ref={noteInputRef}
            value={note}
            placeholder="気づき・観測した問題を1〜2文で"
            className="h-8 flex-1"
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitNote();
              }
              if (event.key === "Escape") {
                // Close only the form; keep the card detail panel open.
                event.stopPropagation();
                setNoteOpen(false);
              }
            }}
          />
          <Button size="sm" disabled={note.trim() === ""} onClick={() => void submitNote()}>
            送信
          </Button>
        </div>
      )}

      <Textarea
        ref={composeRef}
        value={draft}
        placeholder="詳細・自由入力（⌘Enter または Ctrl+Enter で送信）"
        className="min-h-[72px] resize-y font-mono text-xs"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void sendCompose(true);
          }
        }}
      />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={() => void sendCompose(true)}>
          送信
        </Button>
        <Button variant="outline" size="sm" onClick={() => void sendCompose(false)}>
          貼り付けのみ
        </Button>
        {(
          [
            ["enter", "Enter"],
            ["escape", "Esc"],
            ["up", "↑"],
            ["down", "↓"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            variant="outline"
            size="xs"
            title={`cmux send-key ${key}`}
            onClick={() => void sendKey(key)}
          >
            {label}
          </Button>
        ))}
        {/* Two presses within three seconds interrupt; no native dialog. */}
        <Button
          variant="outline"
          size="xs"
          className={cn(
            interruptArmed && "border-destructive text-destructive hover:text-destructive",
          )}
          onClick={() => {
            if (interruptArmed) {
              disarmInterrupt();
              void sendKey("ctrl+c");
              return;
            }
            setInterruptArmed(true);
            interruptTimer.current = window.setTimeout(() => {
              interruptTimer.current = null;
              setInterruptArmed(false);
            }, 3000);
          }}
        >
          {interruptArmed ? "もう一度で中断" : "中断"}
        </Button>
      </div>
    </div>
  );
}

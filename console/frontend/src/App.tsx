import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";

import { BoardView } from "@/components/BoardView";
import { CardDialog } from "@/components/CardDialog";
import { CommanderSidebar } from "@/components/Dock";
import { DetailPanel } from "@/components/DetailPanel";
import { TopBar } from "@/components/TopBar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { ConsoleContext, type ConsoleController } from "@/console-context";
import { api, errorMessage } from "@/lib/api";
import { commanderLink } from "@/lib/board";
import { refreshScreenSoon } from "@/lib/screen";
import {
  DOCK_OPEN_KEY,
  DOCK_WIDTH_KEY,
  SCREEN_OPEN_KEY,
  clampDockWidth,
  readDockWidth,
  readStorage,
  writeStorage,
} from "@/lib/storage";
import { COMMANDER_BOOTSTRAP } from "@/lib/templates";
import type {
  Item,
  SessionLink,
  StateData,
  StateKey,
  SurfaceLink,
  Workspace,
} from "@/lib/types";

export default function App() {
  const [data, setData] = useState<StateData | null>(null);
  const dataRef = useRef<StateData | null>(null);
  const commitData = useCallback((next: StateData | null) => {
    dataRef.current = next;
    setData(next);
  }, []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogOpenRef = useRef(false);

  /* Persisted dock choices; localStorage keys are shared with the old UI. */
  const [dockOpen, setDockOpen] = useState(() => readStorage(DOCK_OPEN_KEY) !== "0");
  const [screenOpen, setScreenOpen] = useState(() => readStorage(SCREEN_OPEN_KEY) === "1");
  /** Transient peek (memory only): a successful send re-shows dock + mirror. */
  const [peek, setPeek] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [dockWidth, setDockWidth] = useState(readDockWidth);
  const [dockResizing, setDockResizing] = useState(false);

  /** Unsent commander draft; kept here so it survives every re-render. */
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const commitDraft = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
  }, []);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);

  /* ---------------------------------------------------------------- data */

  const load = useCallback(async () => {
    try {
      const next = await api<StateData>("/api/state");
      commitData(next);
    } catch (error) {
      toast.error(`ボードを読み込めません: ${errorMessage(error)}`);
    }
  }, [commitData]);

  const patchItem = useCallback(
    async (id: string, patch: Record<string, unknown>): Promise<Item> => {
      const current = dataRef.current;
      if (!current) throw new Error("board not loaded");
      const result = await api<{ item: Item; rev: string }>(
        `/api/items/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify({ rev: current.rev, patch }) },
      );
      const base = dataRef.current ?? current;
      commitData({
        ...base,
        rev: result.rev,
        board: {
          ...base.board,
          items: base.board.items.map((item) => (item.id === id ? result.item : item)),
        },
      });
      return result.item;
    },
    [commitData],
  );

  const patchField = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      try {
        await patchItem(id, patch);
      } catch (error) {
        toast.error(`更新できません: ${errorMessage(error)}`);
        await load();
      }
    },
    [patchItem, load],
  );

  const moveItem = useCallback(
    async (id: string, state: StateKey, label: string) => {
      try {
        await patchItem(id, { state });
        toast.success(`${id} を「${label}」へ移動`);
      } catch (error) {
        toast.error(`移動できません: ${errorMessage(error)}`);
        await load();
      }
    },
    [patchItem, load],
  );

  const createItem = useCallback(
    async (payload: { title: string; project?: string; evidence?: string }) => {
      const result = await api<{ item: Item; rev: string }>("/api/items", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return result.item;
    },
    [],
  );

  const setCommander = useCallback(
    async (link: SessionLink) => {
      const current = dataRef.current;
      if (!current) throw new Error("board not loaded");
      const result = await api<{ commander: SessionLink | null; rev: string }>(
        "/api/commander",
        { method: "PUT", body: JSON.stringify({ rev: current.rev, commander: link }) },
      );
      const base = dataRef.current ?? current;
      commitData({
        ...base,
        rev: result.rev,
        board: { ...base.board, commander: result.commander },
      });
      setSetupOpen(false);
    },
    [commitData],
  );

  /* ----------------------------------------------------------- commander */

  const fillCompose = useCallback(
    (text: string) => {
      if (!commanderLink(dataRef.current)) {
        toast.error("先に司令塔を設定してください");
        return;
      }
      // Never overwrite an unsent draft; append below it instead.
      const current = draftRef.current;
      const next =
        current.trim() === "" ? text : `${current.replace(/\n+$/, "")}\n${text}`;
      commitDraft(next);
      requestAnimationFrame(() => {
        const element = composeRef.current;
        if (element) {
          element.focus();
          element.setSelectionRange(next.length, next.length);
        }
      });
      if (current.trim() !== "") toast("下書きの末尾に追記しました");
    },
    [commitDraft],
  );

  const startCommanderWorkspace = useCallback(
    async (cwd: string) => {
      try {
        const result = await api<{ workspace?: Workspace | null }>(
          "/api/cmux/workspace",
          {
            method: "POST",
            body: JSON.stringify({
              name: "Overlord 司令塔",
              cwd,
              command: "claude",
              description: "Overlord Console の司令塔セッション",
            }),
          },
        );
        await load();
        const created = result.workspace;
        const surface = created?.surfaces?.find((entry) => entry.type === "terminal");
        if (!created || !surface) {
          toast("ワークスペースを作成しました。一覧から選んでください。");
          return;
        }
        await setCommander({ workspace_id: created.id, surface_id: surface.id, cwd });
        fillCompose(COMMANDER_BOOTSTRAP);
        toast.success("司令塔を起動しました");
      } catch (error) {
        toast.error(`起動できません: ${errorMessage(error)}`);
      }
    },
    [load, setCommander, fillCompose],
  );

  const focusSurface = useCallback(async (link: SurfaceLink) => {
    await api("/api/cmux/focus", {
      method: "POST",
      body: JSON.stringify({ workspace: link.workspace.ref, surfaceId: link.surface.id }),
    });
  }, []);

  /**
   * Send a fixed template directly to the commander. Never touches the
   * compose draft, so an unsent draft always survives. An in-flight guard
   * blocks duplicate sends from every caller (dock templates, note form,
   * card buttons). Returns true when the text was sent.
   */
  const sendInFlight = useRef(false);
  const sendTemplate = useCallback(
    async (text: string): Promise<boolean> => {
      if (sendInFlight.current) return false;
      sendInFlight.current = true;
      try {
        const link = commanderLink(dataRef.current);
        if (!link) {
          toast.error("先に司令塔を設定してください");
          return false;
        }
        try {
          await api("/api/cmux/send", {
            method: "POST",
            body: JSON.stringify({ surface: link.surface.id, text, submit: true }),
          });
          toast.success("送信しました");
          // Transient peek so the reply is visible; persisted choices are untouched.
          setPeek(true);
          refreshScreenSoon(400);
          return true;
        } catch (error) {
          toast.error(`送信できません: ${errorMessage(error)}`);
          return false;
        }
      } finally {
        sendInFlight.current = false;
      }
    },
    [],
  );

  const sendCompose = useCallback(
    async (submit: boolean) => {
      const link = commanderLink(dataRef.current);
      const text = draftRef.current;
      if (!link || text.trim() === "") return;
      try {
        await api("/api/cmux/send", {
          method: "POST",
          body: JSON.stringify({ surface: link.surface.id, text, submit }),
        });
        commitDraft("");
        toast.success(submit ? "送信しました" : "貼り付けました");
        refreshScreenSoon(400);
      } catch (error) {
        toast.error(`送信できません: ${errorMessage(error)}`);
      }
    },
    [commitDraft],
  );

  const sendKey = useCallback(async (key: string) => {
    const link = commanderLink(dataRef.current);
    if (!link) return;
    try {
      await api("/api/cmux/key", {
        method: "POST",
        body: JSON.stringify({ surface: link.surface.id, key }),
      });
      refreshScreenSoon(300);
    } catch (error) {
      toast.error(`キーを送れません: ${errorMessage(error)}`);
    }
  }, []);

  /* ------------------------------------------------------------- effects */

  useEffect(() => {
    void load();
  }, [load]);

  /* SSE: reload on board events; reconnect two seconds after a drop. */
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: number | null = null;
    let disposed = false;
    const connect = () => {
      source = new EventSource("/api/events");
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { type?: string; rev?: string };
          if (payload.type === "board" && payload.rev !== dataRef.current?.rev) {
            void load();
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      source.onerror = () => {
        source?.close();
        if (!disposed) timer = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      disposed = true;
      source?.close();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [load]);

  /* Poll every 15 seconds while the tab is visible. */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  /* Escape closes the card detail (unless typing in a textarea or a dialog). */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (dialogOpenRef.current) return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) return;
      if (
        active instanceof Element &&
        active.closest('[data-slot="select-content"], [role="listbox"]')
      ) {
        return;
      }
      setSelectedId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /* -------------------------------------------------------------- render */

  if (!data) {
    return (
      <>
        <Toaster position="bottom-center" />
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          読み込み中…
        </div>
      </>
    );
  }

  const link = commanderLink(data);
  const configured = Boolean(data.board.commander?.surface_id);
  const ready = Boolean(link) && !setupOpen;
  /** Single authority for whether the whole commander dock is shown. */
  const dockVisible = dockOpen || peek;
  /** Single authority for whether the commander screen mirror is shown. */
  const screenVisible = ready && dockVisible && (screenOpen || peek);

  const controller: ConsoleController = {
    data,
    load,
    selectedId,
    select: setSelectedId,
    openNewCardDialog: () => {
      dialogOpenRef.current = true;
      setDialogOpen(true);
    },
    patchItem,
    patchField,
    moveItem,
    createItem,
    setCommander,
    startCommanderWorkspace,
    focusSurface,
    sendTemplate,
    sendCompose,
    sendKey,
    draft,
    setDraft: commitDraft,
    composeRef,
    link,
    configured,
    ready,
    dockVisible,
    screenVisible,
    setupOpen,
    openSetup: () => setSetupOpen(true),
    closeSetup: () => setSetupOpen(false),
    toggleScreen: () => {
      // Hide wins whenever the screen is showing, even via a transient peek.
      const next = !screenVisible;
      setScreenOpen(next);
      setPeek(false);
      writeStorage(SCREEN_OPEN_KEY, next ? "1" : "0");
    },
    dockResize: {
      setWidth: (px: number) => {
        const clamped = clampDockWidth(px);
        setDockWidth(clamped);
        writeStorage(DOCK_WIDTH_KEY, String(clamped));
      },
      setResizing: setDockResizing,
    },
  };

  return (
    <SidebarProvider
      // The dock is the shadcn Sidebar; its open state is dockOpen || peek,
      // persisted to the legacy localStorage key instead of the cookie.
      open={dockVisible}
      onOpenChange={(next) => {
        // Hide wins whenever the dock is showing, even via a transient peek;
        // only the explicit choice is persisted, a peek never is.
        setDockOpen(next);
        setPeek(false);
        writeStorage(DOCK_OPEN_KEY, next ? "1" : "0");
      }}
      className="h-svh min-h-svh"
      style={{ "--sidebar-width": `${dockWidth}px` } as CSSProperties}
      data-resizing={dockResizing ? "true" : undefined}
    >
      <ConsoleContext.Provider value={controller}>
        <Toaster position="bottom-center" />
        <SidebarInset className="min-w-0">
          <TopBar />
          {/* Card detail overlays the board area only, never the dock. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <BoardView />
            <DetailPanel />
          </div>
        </SidebarInset>
        <CommanderSidebar />
        <CardDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            dialogOpenRef.current = open;
            setDialogOpen(open);
          }}
        />
      </ConsoleContext.Provider>
    </SidebarProvider>
  );
}

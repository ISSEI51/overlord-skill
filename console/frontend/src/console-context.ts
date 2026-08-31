import { createContext, useContext, type RefObject } from "react";
import type {
  DeliveryEvent,
  Item,
  SessionLink,
  StateData,
  StateKey,
  SurfaceLink,
} from "@/lib/types";

export type ConsoleController = {
  data: StateData;
  load: () => Promise<void>;

  selectedId: string | null;
  select: (id: string | null) => void;
  openNewCardDialog: () => void;

  /** PATCH one field set; throws on failure (409 handling is the caller's). */
  patchItem: (id: string, patch: Record<string, unknown>) => Promise<Item>;
  /** patchItem + error toast + reload; used by detail-panel editors. */
  patchField: (id: string, patch: Record<string, unknown>) => Promise<void>;
  moveItem: (id: string, state: StateKey, label: string) => Promise<void>;
  /** DELETE a done card; toasts the outcome and reloads the board. */
  deleteItem: (id: string) => Promise<void>;
  createItem: (payload: { title: string; evidence?: string }) => Promise<Item>;

  /**
   * The last delivery frame seen per card id this session. A card with no
   * entry has had no delivery reported to this browser, which does not mean
   * it was never delivered: `items[].delivery` is the record that outlives
   * the session.
   */
  deliveries: Record<string, DeliveryEvent>;
  /** POST /api/items/:id/deliver; throws on a refusal (409 when off). */
  deliverItem: (id: string) => Promise<void>;

  setCommander: (link: SessionLink) => Promise<void>;
  startCommanderWorkspace: (cwd: string) => Promise<void>;
  focusSurface: (link: SurfaceLink) => Promise<void>;

  sendTemplate: (text: string) => Promise<boolean>;
  sendCompose: (submit: boolean) => Promise<void>;
  sendKey: (key: string) => Promise<void>;
  draft: string;
  setDraft: (value: string) => void;
  composeRef: RefObject<HTMLTextAreaElement | null>;

  link: SurfaceLink | null;
  configured: boolean;
  ready: boolean;
  dockVisible: boolean;
  screenVisible: boolean;
  setupOpen: boolean;
  openSetup: () => void;
  closeSetup: () => void;
  dockResize: {
    setWidth: (px: number) => void;
    setResizing: (resizing: boolean) => void;
  };
};

export const ConsoleContext = createContext<ConsoleController | null>(null);

export function useConsole(): ConsoleController {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole outside provider");
  return value;
}

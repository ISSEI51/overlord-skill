import { Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConsole } from "@/console-context";
import { ACTIVE_STATES } from "@/lib/types";
import { cn } from "@/lib/utils";

export function TopBar() {
  const { data, dockVisible, openNewCardDialog } = useConsole();
  const items = data.board.items ?? [];
  const implementing = items.filter((item) => item.state === "implementing").length;
  const active = items.filter((item) => ACTIVE_STATES.includes(item.state)).length;
  const warnings: string[] = [];
  if (implementing > 3) warnings.push(`実装中 ${implementing} 件（上限3）`);
  if (active > 10) warnings.push(`進行中 ${active} 件（上限10）`);
  const { cmux } = data;
  const toggleLabel = dockVisible ? "司令塔を隠す" : "司令塔を表示";

  return (
    <header className="flex items-center gap-4 border-b bg-card px-4 py-2">
      <div className="flex shrink-0 items-center gap-2 font-semibold">
        <span className="text-[15px] text-primary">◧</span>
        <span>Overlord</span>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className="max-w-[46ch] truncate font-mono text-[11px] text-faint"
          title={data.exists ? data.boardPath : `${data.boardPath}（未作成）`}
        >
          {data.boardPath}
        </span>
        {warnings.length > 0 && (
          <span className="shrink-0 text-xs text-warn">{warnings.join(" / ")}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={openNewCardDialog}>
          <Plus />
          気づきを追加
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger
              className="size-8"
              aria-pressed={dockVisible}
              aria-label={toggleLabel}
            />
          </TooltipTrigger>
          <TooltipContent>{toggleLabel}</TooltipContent>
        </Tooltip>
        <Badge
          variant="outline"
          title={cmux.error ?? ""}
          className={cn(
            "font-normal",
            cmux.available ? "border-ok/45 text-ok" : "border-destructive/45 text-destructive",
          )}
        >
          {cmux.available ? "cmux 接続済み" : "cmux 未接続"}
        </Badge>
      </div>
    </header>
  );
}

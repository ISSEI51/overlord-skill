import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { useConsole } from "@/console-context";
import { errorMessage } from "@/lib/api";

/**
 * "気づきを追加" dialog. Cancel and Escape keep what was typed (the
 * component stays mounted); a successful submit clears the note fields.
 */
export function CardDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { createItem, load, select } = useConsole();
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [evidence, setEvidence] = useState("");

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed === "") {
      toast.error("見出しを入力してください");
      return;
    }
    try {
      const item = await createItem({
        title: trimmed,
        project: project.trim() || undefined,
        evidence: evidence.trim() || undefined,
      });
      setTitle("");
      setEvidence("");
      onOpenChange(false);
      await load();
      select(item.id);
    } catch (error) {
      toast.error(`追加できません: ${errorMessage(error)}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>気づきを追加</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label="1行の見出し">
            <Input
              value={title}
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="プロジェクト（任意）">
            <Input
              value={project}
              autoComplete="off"
              onChange={(event) => setProject(event.target.value)}
            />
          </Field>
          <Field label="根拠・再現手順（任意・複数行可）">
            <Textarea
              value={evidence}
              rows={4}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm">
              追加
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              キャンセル
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

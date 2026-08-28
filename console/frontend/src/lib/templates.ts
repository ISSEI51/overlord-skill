import type { Item } from "./types";

/**
 * Fixed instruction texts sent to the commander. They are only ever part of
 * the send payload; skill command strings never appear in inputs or the DOM.
 */

export type CardInstruction = { label: string; text: string };

export function cardInstructions(item: Item): CardInstruction[] {
  return [
    { label: "状況を聞く", text: `${item.id} の状況と次の一手を3行以内で教えてください。` },
    {
      label: "進める",
      text:
        `${item.id} を進めてください。担当のサブエージェントを起動し、` +
        "このカードの状態に必要な作業だけを行わせてください。",
    },
    {
      label: "実装ブリーフ",
      text: `${item.id} の実装ブリーフを作成してください。`,
    },
    {
      label: "独立レビュー",
      text: `${item.id} の独立レビューを、実装したサブエージェントとは別のサブエージェントで実行してください。`,
    },
    {
      label: "完了の可否",
      text: `${item.id} を完了にしてよいか、完成の条件ごとの結果で教えてください。`,
    },
  ];
}

export type DockTemplate =
  | { label: string; text: string; inline?: false }
  | { label: string; prefix: string; inline: true };

export function dockTemplates(): DockTemplate[] {
  return [
    {
      label: "今日の状況",
      text:
        "/overlord-ops 今日の作業状況を整理してください。" +
        "私が決めることは最大3件、実際に試して確認する操作は最大3本に絞ってください。" +
        "各案件は次の一手を1つだけ示してください。",
    },
    {
      label: "作業を割り当て",
      text:
        "空いている実装枠に作業を割り当ててください。" +
        "1件ごとに別のサブエージェントと作業用フォルダを使い、" +
        "docs/product-ops/board.yaml の担当と状態を更新してください。",
    },
    {
      label: "気づきをカードに",
      prefix: "/overlord-improvement-card ",
      inline: true,
    },
    {
      label: "ボード更新",
      text: "docs/product-ops/board.yaml を現在の状況に合わせて更新してください。",
    },
  ];
}

export const COMMANDER_BOOTSTRAP =
  "/overlord-ops この会話を Overlord の司令塔にしてください。" +
  "docs/product-ops/board.yaml を読み、今日の状況を整理してください。";

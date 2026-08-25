# AI Product Operations Skills

複数プロジェクトの要件整理、UX監査、実装準備、独立レビューをAIで並列化するためのスキルセットです。

人間は優先順位、方針、受け入れ確認を判断します。AIは改善カード化、既存コード調査、実装ブリーフ、レビュー、ボード更新を担当します。

## 含まれるスキル

| Skill | 用途 |
| --- | --- |
| `product-ops` | プロジェクト横断の優先順位、作業レーン、日次・週次の整理 |
| `product-improvement-card` | 雑な気づきや問い合わせを根拠付き改善カードへ変換 |
| `product-ux-audit` | 代表シナリオから操作摩擦・回帰・復帰性を監査 |
| `product-implementation-brief` | 改善カードを小さく検証可能な実装ブリーフへ変換 |
| `product-change-review` | 実装者から独立した要件・回帰・リスクレビュー |

## 設計

```text
気づき -> 改善カード -> 優先順位 -> 実装ブリーフ -> 実装 -> 独立レビュー -> 受け入れ
                 |                                                    |
                 +---------- docs/product-ops/board.yaml ------------+
                                      |
                                      +-> AI Product Operations Board Artifact
```

- `docs/product-ops/board.yaml` はAIが読む正本です。
- Artifactは人間が優先順位・進捗・受け入れ待ちを確認する表示です。
- 状態変更では、YAMLを先に更新し、Artifact対応クライアントでは同じデータをArtifactへ反映します。
- 実装中は最大3件、調査・仕様化・レビューを含むアクティブ案件は10件前後に保ちます。

## インストール

### Claude Code

個人用に入れる場合:

```bash
git clone <YOUR_REPOSITORY_URL>
cd ai-product-ops-skills
./scripts/install.sh claude
```

プロジェクト単位で入れる場合は、対象リポジトリで実行します。

```bash
/path/to/ai-product-ops-skills/scripts/install.sh project
```

Claude Codeは `.claude/skills/<skill-name>/SKILL.md` をプロジェクトスキルとして読み込みます。起動後、`/product-ops` のように実行できます。

### Codex

```bash
git clone <YOUR_REPOSITORY_URL>
cd ai-product-ops-skills
./scripts/install.sh codex
```

既存の同名スキルがある場合、インストーラーは上書きせず停止します。更新時は、対象スキルを確認してから置き換えてください。

## 初期化

対象リポジトリのルートでClaude CodeまたはCodexを起動し、以下を実行します。

```text
/product-ops
このプロジェクトのプロダクト運用を初期化してください。
コード、既存の仕様、プロジェクト規約を確認し、
docs/product-ops/board.yaml を作成してください。
最初に私が判断すべき案件は最大3件にしてください。
```

Artifactを作成できるクライアントでは、同時に `AI Product Operations Board` を作成・更新します。通常のターミナルではArtifact画面を直接操作できないため、YAMLの更新と `ARTIFACT_UPDATE` の出力までを実行します。

## 日常の使い方

### 気づきを残す

```text
/product-improvement-card
コール終了後に次の顧客へ進みにくい。保存できたかも分かりにくい。
既存コードを確認して改善カードにしてください。実装はしないでください。
```

### 使用感を監査する

```text
/product-ux-audit
「顧客検索 -> 発信 -> 通話中メモ -> 終了処理 -> 次の顧客」を監査してください。
待機、迷い、誤操作、失敗からの復帰を確認してください。実装はしないでください。
```

### 実装へ進める

```text
/product-implementation-brief RC-UX-001
```

ブリーフを確認し、承認する場合だけ実装を指示します。

```text
RC-UX-001を実装ブリーフに従って実装してください。
1チケットにつき1 worktreeを使い、完了時はテスト結果と未確認事項だけを報告してください。
```

### 独立レビューする

別のエージェントまたは新しいセッションで実行します。

```text
/product-change-review RC-UX-001
```

## 毎日の運用

朝に以下を実行し、あなたが判断する案件を最大3件に絞ります。

```text
/product-ops
今日の作業状況を整理してください。
判断が必要な案件は最大3件、受け入れ確認が必要なシナリオは最大3本に絞ってください。
各案件は次の一手を1つだけ示してください。
```

日中は気づきを改善カード化します。夕方はレビュー結果と受け入れ待ちの代表シナリオだけを確認します。

## Artifactの扱い

Artifactは人間の判断画面であり、AIの正本ではありません。AIは常に `docs/product-ops/board.yaml` を読んで作業します。

Artifactとリポジトリ編集の両方を扱えるクライアントでは、スキルが両方を同時に更新します。ターミナルだけの環境ではArtifactを直接更新できないため、出力された `ARTIFACT_UPDATE` をArtifact対応のメインチャットへ渡してください。

## 変更と共有

チームで共有する場合は、プロジェクトへ `docs/product-ops/board.yaml` と `.claude/skills/` をコミットしてください。個人だけの優先順位を管理する場合は、`docs/product-ops/board.yaml` をGit管理対象外にしてください。

# CLAUDE.md

## プロジェクト
- このリポジトリ `kentokento469/work-1` は **WorkCore**（中小企業向け統合業務管理・自動化アプリ）のリポジトリ。
  リポジトリ名は `workcore` ではないが、「workcore リポジトリ」と言われたらここを指す。
- 詳細は README.md を参照。

## 開発ルール（オーナーの指示）
- GitHub への push は確認不要（オーナー承認済み・2026-10-15「pushは自動でやって毎回確認しなくていい」）。作業が完了・検証済みになったら main に直接 push してよい（main への push で GitHub Pages に公開される）。
  - 各フェーズの指示書に「push・公開は事前確認」と書かれていても、push と GitHub Pages への公開は確認せずに自動で行う（2026-10-15 オーナーが再確認：「だから自動でpushしてください。毎回聞かないでいいと伝えました」）。
- PR作成・有料サービス利用・外部への情報送信は、実行前に必ずオーナーに確認する。
- 実在の Microsoft / Google / Apple アカウント作成、メール送信、外部申請は行わない。
- 外部AI API・有料サービスは使わない。

## コマンド
- `npm run typecheck` / `npm test` / `npm run build` / `npm run test:e2e`（`CHROMIUM_PATH` で Chromium を指定可）

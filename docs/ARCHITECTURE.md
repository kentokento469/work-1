# WorkCore システム構成（Phase 2 時点）

## 1. レイヤー構成

```
┌──────────────────────────── ブラウザ (iPhone Safari / PC) ────────────────────────────┐
│ UI層        pages/  features/  ui/                                                  │
│             画面・フォーム・共通部品。業務ルールは持たない                                  │
│                │ run(action, message, { undo })                                      │
│ 状態管理    app/AppData.tsx  … スナップショット + 集計結果を Context で配布               │
│             app/hooks.ts     … 検索条件の URL 保持・下書き保存                           │
│             app/router.ts    … ハッシュルーティング・スクロール位置の復元                     │
│                │                                                                     │
│ サービス層  services/workcoreService.ts  社員・タスク・入社準備・部署・データ管理            │
│             services/helpdeskService.ts  問い合わせ・FAQ・カテゴリ                        │
│             services/common.ts           AppError・操作履歴・トランザクション中断             │
│                │ 検証 → 書き込み → 操作履歴 を 1 トランザクションで実行                       │
│ ドメイン層  domain/types.ts              型定義（唯一の定義元）                             │
│ (純粋関数)  domain/helpdesk/classifier   自動分類                                         │
│             domain/helpdesk/search       FAQ候補・過去事例検索                             │
│             domain/helpdesk/taskSuggest  問い合わせ→タスク提案                             │
│             domain/helpdesk/inquiry      状態遷移・完了条件・採番・検証                      │
│             domain/helpdesk/secrets      秘密情報の検出・伏せ字化                            │
│             domain/helpdesk/analytics    ヘルプデスク分析                                  │
│             domain/analytics, automation/onboardingEngine（Phase 1）                     │
│                │                                                                     │
│ 永続化層    data/db.ts      IndexedDB スキーマ v2・マイグレーション                         │
│             data/backup.ts  JSON バックアップ（v1/v2 互換）・検証                           │
│             data/csv.ts     CSV 出力（UTF-8 BOM・CSVインジェクション対策）                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**原則**
- ドメイン層は React・IndexedDB に依存しない。入出力はプレーンなデータなので、Vitest で直接テストでき、将来サーバーへ移す場合もそのまま使える
- 画面からの書き込みは必ずサービス層を通す。サービス層は「検証 → 書き込み → 操作履歴」を 1 トランザクションで行い、失敗時は `abortWith()` で取り消してから `AppError` を投げる（部分的な書き込みを残さない）
- 画面は `run()` だけを使う。成功時は全データを再読込して集計を再計算するため、どの画面の変更もダッシュボードに即時反映される

## 2. データモデル

| ストア | 主なフィールド | インデックス |
| --- | --- | --- |
| departments | id, name, order | — |
| employees | id, employeeNumber, name, departmentId, status… | byNumber（**一意**）, byDepartment |
| tasks | id, employeeId, **inquiryId**, ruleId, source(`manual`/`onboarding`/`inquiry`), status… | byEmployee, byStatus, **byInquiry** |
| rules | 入社準備ルール | — |
| activities | 操作履歴（最大300件） | byAt |
| meta | `initialized`, `schemaMigratedToV2`, `req:<requestId>`（二重送信防止キー） | — |
| **inquiries** | number, receivedAt, requesterId, requesterName, requesterDepartmentId, title, body, categoryId, priority, assignee, dueDate, status, resolution, resolvedAt, closedAt, classification, faqIds, history[] | byNumber（**一意**）, byStatus, byRequester |
| **faqs** | question, answer, categoryId, keywords, enabled, sourceInquiryId | — |
| **inquiryCategories** | name, keywords, defaultDepartmentId, defaultAssignee, slaBusinessDays, enabled, isFallback | — |

設計判断
- **タスクは Phase 1 と同じストア・同じ型を再利用**し、`inquiryId` と `source: 'inquiry'` を足しただけ。タスク一覧・ダッシュボード・CSV はそのまま問い合わせ由来のタスクも扱える
- 問い合わせは申請者の **ID と受付時点の氏名・部署を両方保存**する。社員を削除しても履歴が読め、社員が存在する間はリンクで移動できる
- 対応履歴（history）は問い合わせ内に埋め込み。1件の問い合わせと一緒に読み書きされ、件数も限られるため別ストアにしない
- 自動分類の結果（`classification`）は受付時のスナップショットとして保存し、担当者が候補を採用したかも記録する（分析の「採用率」に使う）

## 3. スキーマのマイグレーション（v1 → v2）

`data/db.ts` の `upgrade()` でバージョンごとに段階的に移行する。

1. `inquiries`・`faqs`・`inquiryCategories` ストアを作成し、カテゴリ初期値を投入
2. `tasks` に `byInquiry` インデックスを追加し、既存タスク全件に `inquiryId: null` を付与（カーソルで更新）
3. `meta.schemaMigratedToV2` に移行日時を記録

既存の社員・タスク・ルール・履歴は一切削除しない。Phase 1 の利用者向けに、既存データを残したままヘルプデスクのデモデータだけを追加する機能（`addHelpdeskDemo`、問い合わせが1件でもあれば実行しない）を用意した。
検証：単体テスト（fake-indexeddb で v1 DB を作成→v2 で開く）と、実ブラウザで Phase 1 版→Phase 2 版を同一オリジンで開く E2E（`e2e/migration.spec.ts`）。

## 4. バックアップ互換性

- 出力は `schemaVersion: 2`。読み込みは 1 と 2 を受け付ける
- v1 を読み込んだ場合はヘルプデスク関連を空・カテゴリを初期値で補い、タスクに `inquiryId: null` を補完する
- 全レコードを型ガードで検証し、さらに参照整合性（タスク→問い合わせ、問い合わせ→カテゴリ、問い合わせ番号の重複など）を検証。問題があれば現在のデータを一切変更しない

## 5. 問い合わせのライフサイクル

```
 新規 ──┬──> 対応中 <──> 回答待ち / 保留
        │      │  (タスク作成時、新規なら自動で対応中へ)
        └──────┴──> 解決済み ──(申請者確認 + 解決内容 + 関連タスク全完了)──> 完了（最終・編集不可）
                       │
                       └──> 再オープン（対応中などへ戻せる）
```

- **解決済み**：担当者の対応が終わった状態。解決内容が必須。初めて解決済みになった時刻を `resolvedAt` に記録（解決時間の計測に使う）
- **完了**：申請者が解決を確認し、案件を閉じた状態。`checkClosable()` が 3 条件を検査し、満たさない場合は理由を表示して拒否
- タスクがすべて完了しても問い合わせは自動で閉じない（タスク完了≠問い合わせ完了）。代わりに詳細画面の「次にやること」で「解決済みにする」を提示する

## 6. 自動化処理の流れ

```
問い合わせ入力 ─> classifyInquiry()  ─> カテゴリ・優先度の候補 + 根拠
              ─> suggestFaqs() / findSimilarCases() ─> FAQ（確定）/ 過去事例（未検証）
受付          ─> createInquiry(requestId)  … 冪等。採番・履歴・分類スナップショット
タスク提案    ─> previewTasks() ─> proposeInquiryTasks()  … ルール判定・期限計算・重複検出
承認          ─> applyTasks()   … トランザクション内で再計算し重複を再チェックして登録
```

いずれも純粋関数＋サービス層で構成しているため、将来「承認フローで計画を保留する」「外部チケットシステムへ送る」といった拡張は、サービス層に処理を足すだけで済む。

## 7. 安全性のための仕組み

| 仕組み | 実装 |
| --- | --- |
| 二重送信防止 | 問い合わせフォームごとに `requestId` を発行。サービス層は `meta.req:<id>` を確認し、同じキーなら最初の結果を返す。DB の一意インデックス（問い合わせ番号）でも二重採番を防ぐ |
| 重複タスク防止 | ルールID + 正規化したタスク名で判定。プレビュー時と登録時の両方で検査 |
| 秘密情報 | `detectSecrets()` を UI（警告・伏せ字化）とサービス層（保存拒否）の両方で実行。下書きにも保存しない。操作履歴は番号・件名のみ |
| 取り消し | 削除系は削除前のデータを返し、`restore*()` で復元。通知の「元に戻す」から実行 |
| 入力の保護 | モーダルは変更がある時だけ破棄確認。問い合わせ登録は下書きを自動保存 |

## 8. ディレクトリ

```
src/
  app/        ルーター・状態管理・レイアウト・テーマ・共通フック
  domain/     型・日付・検証・集計・テキスト処理 / helpdesk/（分類・検索・提案・状態遷移・秘密情報・分析・初期マスタ）
  automation/ 入社準備エンジン（Phase 1）
  data/       IndexedDB・バックアップ・CSV
  services/   サービス層
  demo/       架空企業のデモデータ（Phase 1 + ヘルプデスク）
  features/   画面部品（フォーム・タスク行・ルール設定・実演ガイド・ヘルプデスク部品）
  pages/      画面（helpdesk/、settings/ を含む）
  ui/         汎用UI部品（Button, Card, Modal, Toast, グラフ など）
e2e/          Playwright（Phase 1 / Phase 2 / マイグレーション）
docs/         設計資料
```

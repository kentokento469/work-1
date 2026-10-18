# WorkCore システム構成（Phase 4 時点）

Phase 3 で追加した在庫・資産・購買と自動化エンジンは §9〜13、Phase 4 の書類処理は §14〜18 を参照。§1〜8 は Phase 2 までの構成で、Phase 3 でも変わっていない。

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
│             services/inventoryService.ts 在庫・資産・発注・自動化提案の実行（Phase 3）       │
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
│             domain/inventory/  在庫計算・発注候補・在庫分析・初期マスタ（Phase 3）          │
│             automation/engine, inventoryAutomations  自動化の判定（Phase 3、UI非依存）     │
│                │                                                                     │
│ 永続化層    data/db.ts      IndexedDB スキーマ v3・マイグレーション                         │
│             data/backup.ts  JSON バックアップ（v1/v2/v3 互換）・検証                        │
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
  automation/ 入社準備エンジン（Phase 1）、自動化エンジンと在庫関連の自動化（Phase 3）
  data/       IndexedDB・バックアップ・CSV
  services/   サービス層
  demo/       架空企業のデモデータ（Phase 1 + ヘルプデスク + 在庫・資産・発注）
  features/   画面部品（フォーム・タスク行・ルール設定・実演ガイド・ヘルプデスク部品）
  pages/      画面（helpdesk/、settings/、inventory/、自動化センター を含む）
  ui/         汎用UI部品（Button, Card, Modal, Toast, グラフ など）
e2e/          Playwright（Phase 1 / Phase 2 / Phase 3 / マイグレーション）
docs/         設計資料
```

---

## 9. Phase 3：在庫・資産・購買のデータモデル

**「数量で管理する在庫」と「1台ずつ管理する資産」を分ける。** マウスやコピー用紙は数量（在庫数）だけを持ち、PC・スマートフォンは資産番号つきの個体として台帳で管理する。品目マスタの `tracking: 'quantity' | 'asset'` で切り替える。

| ストア | 主なフィールド | インデックス |
| --- | --- | --- |
| items | code（ITM-0001）, name, category, maker, model, unit, tracking, minStock（発注点）, targetStock（適正在庫）, unitPrice（参考単価）, defaultLocationId, defaultSupplierId, active | byCode（**一意**） |
| stockLevels | `id = itemId@locationId`, quantity（保管場所ごとの実在庫） | byItem |
| stockMovements | type（receive/issue/transfer/adjust/stocktake）, delta, quantity, balanceAfter, reason, refType, refId, employeeId, at | byItem, byAt |
| reservations | itemId, employeeId, quantity, status（active/backorder/fulfilled/released）, key（重複防止） | byItem, byEmployee |
| assets | assetNumber（AST-0001）, itemId, serialNumber, status, assigneeId と受付時点の氏名・部署, purchaseCost（取得価額）, purchaseOrderId, warrantyUntil | byNumber（**一意**）, byItem, byAssignee |
| assetEvents | assetId, type（register/reserve/release/assign/return/loan/status/edit）, fromStatus, toStatus, employeeId/Name, inquiryId, note, at | byAsset, byInquiry |
| locations / suppliers | 保管場所 / 仕入先（架空・`.example` ドメイン） | — |
| purchaseSuggestions | itemId, quantity（推奨）, reasons, status（open/ordered/dismissed/resolved） | byItem |
| purchaseOrders | number（PO-年-連番）, supplierId, lines（quantity, unitPrice, receivedQuantity）, status, expectedDate, requestedBy, approvedBy, history | byNumber（**一意**） |
| equipmentRules | scope（common / dept_xxx）, itemId, quantity | — |
| automationRuns | automationId, key, status（applied/dismissed/failed/auto）, results, error, at | byKey |

**在庫を直接書き換えない。** 数量の変更はすべて `applyMovement()` を通り、保管場所ごとの在庫を増減させると同時に入出庫履歴を1件追加する。実在庫は常に「入出庫履歴の合計」と一致し、バックアップの復元時にもこの一致を検査する（イベントソーシングの考え方。META_DESIGN R14）。取り消しも履歴を消さず、逆向きの記録（`refType: 'reversal'`）を足す。

### 9.1 在庫の数量の定義（`domain/inventory/stock.ts`）

| 用語 | 定義 |
| --- | --- |
| 実在庫 onHand | 保管場所ごとの在庫の合計（＝入出庫履歴の合計）。個体管理品は「未使用＋予約済み」の資産数 |
| 予約 reserved | 引き当て済みの数量（入社者向けなど）。出庫はされていない |
| 利用可能 available | onHand − reserved。出庫・新たな予約はこの範囲だけ |
| 入荷待ち需要 backorder | 在庫がなく引き当てられなかった予約（入荷したら古い順に自動で引き当て） |
| 発注残 onOrder | 承認済み・一部入荷の発注書の未入荷数 |
| 計画中 planned | 下書き・承認待ちの発注書の数量 |
| 見込み在庫 projected | available − backorder + onOrder |
| 在庫不足 | projected < minStock |
| 推奨発注数 | targetStock − (projected + planned)（0以下なら候補を作らない） |

発注残は**在庫ではなく見込みにだけ**加算する。入荷登録（承認済みの発注書のみ・未入荷数まで）で初めて実在庫が増える。

### 9.2 状態遷移

```
資産:   未使用 ──予約──> 予約済み ──引き渡し──> 使用中 ──返却──> 未使用 / 修理中 / 故障
          │                │                   │
          └───────<予約解除─┘                   └──故障受付──> 修理中 ──> 未使用
        未使用・修理中・故障 ──> 廃棄予定 ──> 廃棄済み（最終・戻せない）   ※廃棄予定 → 未使用 には戻せる
        使用中 ──> 修理中 / 故障、 故障 ⇄ 修理中、 修理中 ──> 未使用
        ※ 予約済みの機器は予約した本人以外に貸し出せない／使用中の機器を別の人に貸し出せない

発注書: 下書き ──申請──> 承認待ち ──承認（承認者必須）──> 承認済み（入荷待ち）──入荷──> 一部入荷 ──> 入荷完了
          │                 └──差し戻し──> 下書き
          └─────取り消し（入荷前のみ）─────> 取消
発注候補: 未対応(open) ──発注書作成──> 発注済み(ordered)  /  見送り(dismissed)  /  不足解消で自動終了(resolved)
```

## 10. 自動化エンジン（`automation/engine.ts`）

UI から独立した純粋関数として実装し、画面・サービス層・テストのどこからでも同じ判定を呼べる。

```ts
interface AutomationDefinition {
  id; name; description;
  trigger: string;                 // 実行条件（画面に表示）
  approval: 'required' | 'auto';   // 承認が必要か
  detect(ctx: { data, today, stock }): AutomationProposal[];  // 純粋関数
}
interface AutomationProposal {
  automationId; key;               // key = 対象 + 実行内容の指紋（重複防止）
  title; conditions[];             // 提案の根拠
  actions: { id, kind, label, requiresApproval, ... }[];  // 実行内容（チェックで選択）
  warnings[];
}
```

| 自動化 | 実行条件 | 実行内容 | 承認 |
| --- | --- | --- | --- |
| 入社準備：必要機器の判定と確保 | 入社予定者がいる（入社日の早い順に在庫を割り当て） | 資産の予約・数量の予約・在庫不足は入荷待ち記録・準備タスク／部署異動で不要になった分の解除 | 要 |
| 入社取り消し・退職：予約の解除 | 予約を持つ社員が退職扱い・削除済み | 予約の解除（資産は未使用に戻る） | 要 |
| 退職予定者：貸与資産の返却 | 退職日まで30日以内で、使用中の資産がある | 資産ごとの返却確認タスク | 要 |
| 故障受付：代替機の手配 | 未解決の問い合わせに故障を示す語があり、申請者に使用中の機器がある | 故障機を修理中に・代替機の貸出（なければ入荷待ち）・修理手配と引き渡しのタスク | 要 |
| 在庫不足：発注候補の自動作成 | 在庫を変える操作のたび | 発注候補（下書き）の作成・更新・終了 | 自動（下書きのみ） |

**実行の流れ（`InventoryService.applyProposal`）**
1. 処理履歴（automationRuns）に同じ key の「実行・見送り」があれば何もしない（再読み込み・連打でも二重実行しない）
2. **同じトランザクション内で判定をやり直し**、key が一致し、選んだ操作がすべて残っていることを確認する。状況が変わっていれば「状況が変わったため実行できません」で全体を取り消す
3. 選んだ操作を順に実行（予約・貸出・状態変更・タスク作成）。途中で失敗したら全体を取り消し、失敗を別トランザクションで処理履歴に記録
4. 成功時は実行結果を処理履歴に記録。発注候補の同期も同じトランザクションで行う

判定はデータの並び順に依存しない（全判定で入社日・受付日時・番号の順に並べてから割り当てる）。承認時の再計算と画面表示の提案が一致することを単体テストで確認している。

## 11. 部門をまたぐ連携（同じ情報を再入力しない）

```
社員（入社日・部署） ──判定──> 必要機器 ──承認──> 予約（社員に紐づく）＋ 準備タスク（社員・資産に紐づく）
                                    └─在庫不足─> 入荷待ち ──> 発注候補 ──> 発注書 ──入荷──> 自動で引き当て
問い合わせ（申請者） ──判定──> 申請者の使用中機器 ──承認──> 修理中 ＋ 代替機の貸出（資産の履歴に問い合わせID）
                                                          ＋ タスク（問い合わせ・資産に紐づく）
社員（退職日） ──判定──> 使用中の資産 ──承認──> 返却確認タスク（資産ごと）
```

- 社員詳細に「貸与機器・予約」、問い合わせ詳細に「関連機器」（提案もその場で承認可能）、タスクに資産へのリンクを表示し、どこからでも関連先へ移動できる
- 問い合わせに紐づくタスクは `source: 'inquiry'`（問い合わせの対応タスクとして扱う）、それ以外の自動化タスクは `source: 'automation'`

## 12. スキーマのマイグレーション（v2 → v3）とバックアップ

- `migrateToV3`：在庫関連の12ストアを作成し、保管場所・仕入先の初期マスタだけを投入（品目・在庫は空）。既存の社員・タスク・問い合わせ・FAQ には触れない。`meta.schemaMigratedToV3` に日時を記録
- 既存利用者は「データ管理 → 在庫のデモデータを追加」で、既存データを残したまま在庫デモ（品目・資産・発注書・機器ルール）を追加できる（品目が1件でもあれば実行しない）
- バックアップは `schemaVersion: 3`。v1・v2 を読み込んだ場合は在庫を空・マスタを初期値で補う
- 復元時の検証：型ガード、参照整合性（在庫→品目・保管場所、資産→品目・社員、発注書→仕入先・品目、予約→品目など）、**在庫数＝入出庫履歴の合計**。1つでも不一致なら現在のデータを一切変更しない

## 13. 整合性のための仕組み（Phase 3 追加分）

| リスク | 対策 |
| --- | --- |
| 二重出庫・連打・再読み込みでの重複 | 画面ごとに `requestId` を発行し、`meta.req:<id>` で処理済みを判定（Phase 2 と同じ）。自動化は処理履歴の key で判定 |
| マイナス在庫 | `applyMovement()` が保管場所単位で検査し、マイナスになる操作は全体を取り消す |
| 予約分の出庫 | 出庫は利用可能数（実在庫 − 予約）まで |
| 二重貸出 | 資産の状態遷移を限定（使用中→貸出不可、他人の予約済み→貸出不可） |
| 入荷完了前の在庫加算 | 入荷登録は承認済み・一部入荷の発注書だけ、未入荷数まで |
| 部分的な失敗 | すべての操作を1つの IndexedDB トランザクションで実行し、例外時は `abortWith()` で全体を取り消す（MDN IDBTransaction、META_DESIGN R16） |
| 削除による履歴消失 | 履歴のある品目は無効化のみ。資産は削除せず「廃棄済み」。資産・予約を持つ社員は削除不可 |
| 古い提案の実行 | 承認時に再判定し、key・選択した操作が一致しなければ拒否 |

---

## 14. Phase 4：書類処理のデータモデル

| ストア | 主なフィールド | インデックス |
| --- | --- | --- |
| documents | number（DOC-2026-0001）, type, status（needs_review / confirmed / archived）, method（pdf_text / ocr / mixed / manual）, fields（現在の値）, extracted（自動抽出した値・抽出元の行・ページ・確実性・理由・OCR信頼度）, reviewed（確認済みの項目）, lines（明細）, taxLines, pages（ページ別の抽出元テキスト）, file（元ファイルの参照・SHA-256・ページ数・解析したページ）, employeeId / inquiryId / purchaseOrderId, inventory（在庫への反映記録）, notDuplicateOf, history, createdAt / updatedAt / deletedAt | byNumber（**一意**） |
| documentFiles | documentId, name, mime, size, hash, data（**ArrayBuffer**） | byDocument, byHash |

設計判断
- **書類と元ファイルを別ストアに分ける。** 画面の再描画のたびに読む全データのスナップショット（`loadSnapshot`）には documents だけを含め、数MBになり得る元ファイルはプレビュー・バックアップの時だけ読む
- **元ファイルは Blob ではなく ArrayBuffer で保存する。** iOS Safari の IndexedDB では Blob の保存に過去に不具合があったため、構造化複製が確実な ArrayBuffer を選んだ
- **「現在の値」と「自動抽出した値」を分けて持つ。** 修正前の値・抽出元を後から確認でき、再抽出しても利用者が手で直した項目は上書きしない（現在の値が前回の抽出値と同じ・空の項目だけを置き換える）
- **削除は2段階。** `deletedAt` を付けてゴミ箱へ（元に戻せる）、完全削除はゴミ箱からのみ。在庫に反映した書類は入出庫履歴の根拠なので完全削除できない
- 社員・問い合わせを削除しても書類は残し、関連付けだけを外す（取り消すと戻る）

## 15. 解析パイプライン（`features/documents/engine/`）

```
取り込み ─> ファイル判定 (fileKind) ─> サイズ・保存容量の確認 ─> SHA-256 ─> 同じハッシュの書類があれば警告
        ─> 書類と元ファイルを1トランザクションで保存 (DocumentService.create)   ← OCR 前に保存し、失敗しても原本は残る
解析     ─> PDF: 選んだページを1ページずつ
              ├ getTextContent() の文字が15文字以上 → そのまま使う (pdf_text)
              └ 足りない → 長辺2400px以下で描画 → OCR → キャンバスを解放 (ocr)
         ─> 画像: 長辺2400px以下に縮小 (EXIF の向きを反映) → OCR
         ─> extractDocument() で項目化 (純粋関数) ─> applyExtraction()
確認     ─> ReviewForm (一時保存 / 確認完了) ─> saveReview()
```

- PDF.js と Tesseract.js は**動的 import**（必要になった時だけ読み込む）。OCR は Tesseract.js の Web Worker 内で実行し、画面を止めない
- キャンセルは AbortController → Worker を終了。画面を離れた場合も中断する
- OCR エンジン・言語データは WorkCore 自身から配信し（`scripts/copy-ocr-assets.mjs` がビルド前に `node_modules` から `public/vendor/` へコピー）、初回に利用者の操作で Cache Storage に保存。以降はキャッシュから Blob URL / メモリで Tesseract に渡すため、オフラインでも動く
- tesseract.js 7.0.0 の不具合（言語データをオブジェクトで渡すと初期化に失敗）は、配信用 Worker のコピーの1か所を修正して回避。想定と異なる構成ならビルドを止める

## 16. 項目抽出（`domain/documents/extract.ts`）

| 段階 | 内容 |
| --- | --- |
| 正規化 | NFKC（全角英数→半角）、円記号の揺れ、1文字ずつ空白で区切られた行（OCR特有）だけ空白を詰める |
| 種類の判定 | タイトルらしい短い行の「請求書」「領収書」など → 本文の定型句（「上記正に領収いたしました」）→ レシートの語（「お預り」「お釣り」） |
| 項目 | ラベル（「ご請求金額」「支払期限」「登録番号」など）と値の形式で抽出。ラベルの同じ行になければ次の行も見る。日付は西暦・和暦（令和・平成）に対応し、存在しない日付は除外 |
| 確実性 | high：ラベルと形式が一致／medium：ラベルが曖昧、位置からの推定／low：候補が複数、検算が合わない。**抽出元の行の OCR 信頼度が70%未満なら low に下げる**（文字認識の信頼度と抽出の確実性は別に記録） |
| 検算 | 小計＋消費税＝合計なら3項目を high、合わなければ合計を low。明細の数量×単価＝金額、支払期限＜発行日なども確認画面で注意 |
| 補完しない | 読み取れない項目は作らない（空欄）。書類名も推測しない |

## 17. 重複検出（`domain/documents/duplicates.ts`）

| 区分 | 条件 | 扱い |
| --- | --- | --- |
| 完全一致 | 元ファイルの SHA-256 が同じ | 取り込み時に確認ダイアログ（登録は中止も続行も可） |
| 一致の可能性が高い | 同じ種類で、書類番号が一致し、発行元（表記ゆれを吸収）または登録番号も一致 | 確認画面に警告と比較画面 |
| 類似 | 取引先（発行元・表記が近い発行元・登録番号）か書類番号の一致に加えて、発行日か合計金額が一致 | 同上 |

自動で削除・統合はしない。比較画面で「別の書類」と判断すると `notDuplicateOf` に記録し、その組み合わせでは以後警告しない。

## 18. Phase 1〜3 との連携・バックアップ・移行

- **在庫への引き渡し**（`InventoryService.receiveFromDocument`）：確認済みの書類だけ・1書類1回だけ。利用者が品目の対応付けと数量を確認して実行。発注書に関連付けていれば発注書の入荷として登録（発注残を減らし、個体管理品は資産を自動登録）、なければ数量管理品を入庫。書類・在庫・発注書・発注候補を同じトランザクションで更新し、入出庫履歴には `refType: 'document'` を記録
- **関連書類**：社員・問い合わせ・発注書の詳細画面に表示（`features/documents/light.tsx`。OCR 関連のコードを含めない軽量な部品）
- **DB v3 → v4**：`documents`・`documentFiles` ストアを作成するだけ。既存データには触れない
- **バックアップ v4**：`data.documents` は常に含め、元ファイルは任意で `files`（Base64）に含める。復元前に `decodeBackupFiles()` がサイズと SHA-256 を検証し、1件でも一致しなければ復元しない。元ファイルを含まない書類は抽出結果だけ復元し、画面で「元ファイルがこの端末にありません」と表示
- **Phase 5 への拡張点**：`DocumentRecord` の確定（`status: 'confirmed'`）を自動化エンジン（`AutomationDefinition.detect`）の入力にできる。例：確認済みの納品書で在庫未反映のものを「在庫反映の提案」として出す、請求書の支払期限から支払タスクを提案する

## 19. Phase 5：自動化ルールの一元管理（`automation/registry.ts`・`settings.ts`）

- `ALL_AUTOMATIONS = [...WORKFLOW_AUTOMATIONS, ...INVENTORY_AUTOMATIONS]`。定義に `category`（社員・在庫など）と `autoCapable`（自動実行を選べるか）を追加。ルールを足すと、自動化センターの一覧・有効/無効・実行方法・処理履歴・二重実行防止がそのまま使える
- 追加ルール：`onboarding-tasks`（入社準備タスク。Phase 1 の `buildOnboardingPlan` と同じ判定で、`ruleId` 単位で重複しない）、`retirement-procedures`（退職日45日以内：アカウント停止の確認・書類回収・社員証回収のタスク。**アカウントの停止・削除は実行しない**）
- ルールの設定は `settings` ストア（v5 で追加、`{id:'automation', value:{[ruleId]:{enabled, mode}}}`）。`mode:'auto'` は `autoCapable` かつ全操作が `requiresApproval:false` のときだけ有効（サービス層でも再検査し、在庫を動かすルールの自動実行は拒否）
- 自動実行（`WorkCoreService.runAutoAutomations`）：起動時とデータ更新のたびに `AppData` が呼ぶ。実行中に再度呼ばれたら終わってからもう1回だけ（`running/again`）。実行は `applyProposal(..., {auto:true})` と同じ経路で、処理履歴に `status:'auto'` を記録し、同じ key は二度と実行しない
- データ初期化（`clearBusinessData`）でも設定は残す

## 20. AI 連携の設計（`ai/assist.ts`）

```ts
interface AssistProvider {
  id; kind: 'rule' | 'model'; label;
  sendsData: boolean;               // 外部へ送信するか（画面に表示）
  classifyInquiry(text): ...;        // 問い合わせの分類
  summarizeStatus(data, today): ...; // 今日の要点
}
```
現在は `ruleBasedProvider`（kind:'rule'、ラベル「ルールベース（AIではありません）」、sendsData:false）のみ。AI の出力は提案として扱い、確定データには利用者の操作を経て保存する（自動化提案・書類の抽出と同じ）。実モデルを足す場合は、利用者の許可・設定・送信内容の表示を条件に `currentProvider()` を切り替える。

## 21. スマート入力（`domain/input/`・`ui/SmartInputs.tsx`）

| 部品 | 処理 | 適用先 |
| --- | --- | --- |
| `PhoneField` | 入力中は全角→半角のみ（カーソルが動かない）。欄を離れた時・貼り付け時に `formatPhone`（libphonenumber-js を遅延読み込み、種類は番号の先頭から判定）。保存時にも `finalizePhone` で同じ整形。変換中（composition）は値を変えない | 社員・仕入先 |
| `PostalAddressFields` | 7桁で `lookupPostal`（`vendor/postal/先頭3桁.json`、取得結果はメモリにキャッシュ、失敗は再試行可）。複数候補は選択、手で直した欄は上書きせず候補を提示 | 社員 |
| `EmailField` | 欄を離れた時に全角→半角・ドメインを小文字化、形式の誤りもこの時だけ表示 | 社員・仕入先 |
| `AmountField` | 入力中の文字は内部に保持し、数字として読める時だけ値を更新。欄を離れると3桁区切り | 品目の参考単価 |
| `SuggestField` | 既存データの値を `datalist` の候補に | 役職・メーカー・単位・書類の発行元/宛先 |

郵便番号データは `scripts/build-postal-data.mjs` が npm パッケージ jp-postal（KEN_ALL）からビルド時に生成する（`predev`/`prebuild`）。

## 22. 戻る操作（`app/router.ts`・`app/BackLink.tsx`・`app/swipeBack.ts`）

- **履歴の位置**：ハッシュ遷移ごとに積まれる履歴に通し番号（`history.state.wcIdx`）を記録し、番号 → 画面のパスを sessionStorage に保存。`canGoBack()`（アプリ内に戻れる履歴があるか）・`previousPath()` を提供
- **戻るリンク**（`BackLink`）：直前の履歴が戻り先の画面なら `history.back()`、そうでなければ通常の移動。ブラウザの戻る・スワイプと同じ結果になり、一覧の条件（URL のクエリ）とスクロール位置（画面ごとに記録）が残る
- **モーダル**：開くと `pushState({wcIdx, wcModal})`。戻る操作（popstate）で上のモーダルから閉じ、未保存の変更があれば履歴を積み直して破棄確認を出す。画面の操作で閉じたときはアプリ自身が `history.back()` で履歴を取り除く。その完了前の移動は、完了後にやり直す（Chromium は戻る処理で直前の移動を取り消すため）。保存後の画面移動（`navigate`）はモーダルの履歴を置き換える。閉じたモーダルの履歴に戻った場合は1つ飛ばす
- **スワイプ**：ホーム画面から起動した単独表示（`display-mode: standalone` / `navigator.standalone`）のときだけ有効。左端 24px から始まり、横方向に固定されてから縦スクロールを止める。画面幅の30%以上か速いスワイプで `history.back()`（`canGoBack()` が false なら戻らない）。入力欄・`[data-no-swipe]`・横スクロール中の要素の上では反応しない。戻る処理中は次のスワイプを受け付けない。Safari のタブでは標準のスワイプに任せる（二重に戻らない）

## 23. Phase 6：共通通知システム（`domain/notifications.ts`・`ui/notices.tsx`・`app/focus.ts`）

```
実データ (IndexedDB) ──loadSnapshot──▶ AppData
   deriveNotices(data, today, stock, proposals)   … 純粋関数。同じ原因 = 同じ ID
        │
        ├─ navNoticeSummary(key) → ナビのバッジ (未処理件数・最も重い区分)
        ├─ AttentionSection(modules) → 各画面上部の「要対応」(バッジと同じ対象)
        ├─ TargetNotices(targetId) → 詳細画面の理由・操作 (表示で既読)
        ├─ NotificationsPage → 未処理 / 未読 / 解消済み
        └─ WorkCoreService.syncNotices() → settings['notifications'] に初回検出・解消・既読を記録 (変化時のみ書き込み)
```

- 通知 → 対象：`href` は詳細画面、または一覧の `?focus=<対象ID>`。一覧側は対象要素に `data-focus-id` を付け、`useFocusHighlight` が描画を待ってスクロール・強調し、URL から `focus` を外す。ルーターは `focus` 付きの遷移ではスクロール位置を復元しない
- 一覧の絞り込み（`useQueryState`）は URL を先に書き換えてから state を更新する（同時に届く hashchange と競合しない）
- 編集ダイアログの初期化は「開いた時・対象 ID が変わった時」だけ（背景のデータ再読み込みで入力を消さない）

## 24. Phase 7：汎用タスク管理（`services/taskService.ts`）

- `Task` に任意の項目を追加：`startDate`・`projectId`・`parentTaskId`・`tags`・`checklist`・`recurrence`（`freq/interval/weekdays/monthDay/anchor`）・`seriesId`・`nextOccurrenceId`・`dependsOn`・`links`（品目・発注書・書類などへの関連）。`assigneeDepartmentId`・`dueDate` は `null` を許容。旧データには項目が無い＝未設定として全処理が動く（タスクの書き換えを伴う移行は不要）
- DB v6：`projects` ストアを追加（`migrateToV6`）。バックアップ v6（v1〜v5 は `projects=[]`、旧版のタスクのプロジェクト所属は外して取り込む）
- `TaskService`：作成・更新（入力の正規化・検証〔開始日≦期限・タグ・チェックリスト・繰り返しは期限が必要・プロジェクト/親の存在・サブタスク1段・依存の循環〕）、状態変更（完了で繰り返しの次回を1件作成、サブタスクの一括完了）、削除（サブタスクも）と復元、複製、チェック項目の切り替え、期限の変更、プロジェクト（作成・更新・アーカイブ・削除〔所属を外す〕・復元）。`WorkCoreService` の従来のタスク操作は委譲して互換を保つ
- 画面：`TasksPage`（`view=list|board|calendar|projects`、`status`＝主要な絞り込み〔旧来の進捗値も受け付ける〕、詳細条件はクエリに保存）、`QuickAdd`、`BoardView`、`CalendarView`、`ProjectsView`、`RelatedTasksCard`

## 25. Phase 9：データ整合性・保護・復旧

- 書き込みの保護：複数のレコードを書き換える処理（社員・問い合わせ・タスク・プロジェクトの削除と復元、タスクの更新・状態変更、全件の置き換え、修復）は `guardTx` で包み、途中の例外で必ずトランザクションを取り消す。在庫・書類は従来から同等の `run()` を持つ
- 保存エラーの分類：`classifyStorageError`／`storageErrorMessage`（`services/common.ts`）で容量不足・接続切れ・重複・中断を区別し、「変更は取り消され、元のデータは残っている」ことと次の操作を表示。`AppData.run()` は業務エラー以外もこの説明で表示する
- 複数タブ：`BroadcastChannel('workcore-data')` で「変更があった」ことだけを通知し、受け取ったタブは再読み込み（データ本体は送らない）。タスク・社員の編集は、フォームを開いた時点の `updatedAt` を `expectedUpdatedAt` として渡し、変更されていたら `AppError(code: 'conflict')` で保存を止める（`ui/ConflictNotice.tsx` で「最新を読み込む／上書き」を選ぶ）
- 社員の削除：`planEmployeeTaskDeletion` で、未完了のタスク（とそのサブタスク）は削除、完了済みのタスクは `employeeId=null`・`formerEmployee`（削除時点の氏名・社員番号）を付けて残す。元に戻すと関連付けも戻る
- 上書き前の退避：`data/safety.ts`（別の DB `<DB名>-safety` に1世代）。復元・初期化・全削除の直前に現在のデータと書類の元ファイルを退避し、退避できなければ上書きしない。`restoreSafetySnapshot` は戻す前の状態も退避するため往復できる
- 点検と修復：`checkIntegrity`（バックアップの復元と同じ検査を現在のデータに実行）、`repairIntegrity`（任意の参照切れの関連付けを外す。変わったレコードだけ書き換える）
- 移行：版ごとの段階的な移行（`db.ts` の方針コメント）。既存データを移行した場合は `pendingMigrationCheck` を記録し、最初の起動で `verifyMigration` が点検・修復して操作履歴に残す
- 暗号化バックアップ：`data/backupCrypto.ts`（Web Crypto。PBKDF2-SHA256 600,000回 → AES-GCM 256ビット。salt・IV はランダム）。作成時に復号して一致を確認してから保存。パスワードは保存しない（忘れると復元不可）

## 26. Phase 10：業務フロー・アクセシビリティ

- 色：補足の文字の `--color-slate-400/500` をライト・ダークで別の値にし、背景に対して 4.5:1 以上（`index.css`）。全画面・主要なダイアログを axe-core で検査する E2E（`e2e/a11y.spec.ts`）を CI に組み込み、違反があれば公開しない
- キーボード：`Layout` に「本文へスキップ」と `<main id="main" tabIndex={-1}>`。共通の `:focus-visible` の枠。`Modal` は開いているダイアログの積み重ね（`openPanels`）を持ち、一番上だけが Tab（中で循環）と Esc に応える
- 名前と表示の一致：`aria-label` で見た目と違う名前を付けず、表示の文字＋`sr-only` の補足で名前を作る（グラフ・カレンダー・通知のベル）
- ルーター：ダイアログを閉じたときの「履歴を1つ戻す」と画面移動の競合を解消（置き換え中は戻らない・予約の取り消し・`afterModalHistory` で URL の変更を戻り終わりの後に実行）。`useRoute` は購読開始時に最初の描画との差分に追いつく（Safari で起動直後の移動を取りこぼしていた）
- 業務：発注書の承認で申請者本人を拒否（`transitionOrder`）。資産の返却で返却確認タスクを同時に完了（`returnAsset` の `completeTaskIds`）

## 27. Phase 11：セキュリティ・個人情報

- CSP：本番ビルドで `index.html` に meta を挿入（`vite.config.ts` の `cspPlugin`）。`default-src 'self'`・`connect-src 'self' blob: data:`（外部通信の禁止）・`script-src 'self' blob: 'wasm-unsafe-eval'`（OCR のワーカーと WebAssembly）。テーマの初期化は `public/theme-init.js`（インラインのスクリプトを使わない）
- 書類の元ファイルの種類は `safeDocumentMime`／`mimeForImport`（`domain/documents/safeMime.ts`）で対応形式に限定し、それ以外は `application/octet-stream`。保存・表示（blob: URL）・ダウンロード・バックアップの復元のすべてに適用
- エラー：`classifyError`／`reportError`（`services/common.ts`）で分類し、技術的な詳細はコンソールだけに出す
- 自動化の処理履歴 `AutomationRun.targets`（作成・変更した対象）。見送りは `undoDismissProposal` で取り消せる
- 退職者の個人情報の整理：`erasePersonalData`／`restorePersonalData`（連絡先・備考を削除。氏名・社員番号は残す）

## 28. Phase 12：性能・日付処理

- 索引 `buildIndex`（`domain/dataIndex.ts`）を `AppData` の `index` として提供。一覧の各行は ID で引く（件数 × 件数の探索をしない）
- 段階表示 `usePaged`／`ShowMore`（`ui/ShowMore.tsx`）：100件ずつ。絞り込みの変更で先頭から。`mustInclude` で通知などの対象を必ず表示
- 営業日 `domain/calendar.ts`：日本の祝日（規則から計算）・会社の休業日（設定 `settings` の id `calendar`）・営業日の計算。`AppData` がデータの読み込みごとに `setBusinessCalendar` で反映し、期限の計算はこの設定を使う
- 繰り返し `Recurrence.adjust`（休みの日の調整）・`basis`（完了日基準）・`lastRaw`（調整前の予定日。次回の起点）。`nextScheduledDue`
- 性能の計測 `e2e/perf.spec.ts`（`PERF=1` のときだけ実行）

## 29. Phase 13：複数ユーザー・クラウドの設計（設計のみ）

- 設計書 [PHASE13_DESIGN.md](PHASE13_DESIGN.md)。オーナーの承認まで外部サービスは導入しない
- 役割と権限の表 `domain/permissions.ts`（`PERMISSION_MATRIX`・`can`・`canApprovePurchase`・`canChangeRole`）。Phase 14 でサーバー側の判定と画面の表示の両方から使う予定。現在は画面・サービスから使っていない（動作の変更なし）

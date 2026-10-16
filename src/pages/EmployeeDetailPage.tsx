import { formatAddress } from '../ui/SmartInputs';
import { compareDue } from '../domain/tasks';
import { TargetNotices } from '../ui/notices';
import { BackLink } from '../app/BackLink';
import { useState } from 'react';
import { ClipboardList, Headset, Pencil, Plus, Trash2, UserX, Zap } from 'lucide-react';
import { InquiryStatusBadge } from '../features/helpdesk/parts';
import { EmployeeEquipmentCard } from '../features/inventory/RelatedEquipment';
import { RelatedDocumentsCard } from '../features/documents/light';
import { useAppData } from '../app/AppData';
import { navigate } from '../app/router';
import { daysUntilHire } from '../automation/onboardingEngine';
import { formatDateJa, formatDateTimeJa } from '../domain/date';
import type { Task } from '../domain/types';
import { EmployeeFormModal } from '../features/EmployeeFormModal';
import { TaskFormModal } from '../features/TaskFormModal';
import { TaskItem } from '../features/TaskItem';
import { EmployeeStatusBadge } from '../ui/badges';
import { ProgressBar } from '../ui/charts';
import { ConfirmDialog } from '../ui/Modal';
import { Button, Card, CardHeader, EmptyState } from '../ui/primitives';
import { Avatar } from './EmployeesPage';

export function EmployeeDetailPage({ employeeId }: { employeeId: string }) {
  const { empById, deptById, data, run, today } = useAppData();
  const emp = empById.get(employeeId);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [taskEditing, setTaskEditing] = useState<Task | null>(null);
  const [taskCreating, setTaskCreating] = useState(false);

  if (!emp)
    return (
      <EmptyState
        icon={UserX}
        title="社員が見つかりません"
        description="削除されたか、URLが正しくない可能性があります"
        action={<Button onClick={() => navigate('/employees')}>社員一覧へ戻る</Button>}
      />
    );

  const tasks = data.tasks
    .filter((t) => t.employeeId === emp.id)
    .sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || compareDue(a, b));
  const inquiries = data.inquiries.filter((i) => i.requesterId === emp.id);
  const done = tasks.filter((t) => t.status === 'done').length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const dept = deptById.get(emp.departmentId);
  const days = daysUntilHire(emp, today);

  const rows: [string, string][] = [
    ['社員番号', emp.employeeNumber],
    ['所属部署', dept?.name ?? '不明'],
    ['役職', emp.position || '—'],
    ['雇用区分', emp.employmentType],
    ['入社日', `${formatDateJa(emp.hireDate)}${emp.status === 'pending' && days >= 0 ? `（あと${days}日）` : ''}`],
    ['退職日', formatDateJa(emp.retireDate)],
    ...(emp.contact?.phone ? [['電話番号', emp.contact.phone] as [string, string]] : []),
    ...(emp.contact?.email ? [['メール', emp.contact.email] as [string, string]] : []),
    ...(emp.contact && (emp.contact.postalCode || emp.contact.prefecture) ? [['住所', formatAddress(emp.contact)] as [string, string]] : []),
    ['最終更新', formatDateTimeJa(emp.updatedAt)],
  ];

  return (
    <>
      <BackLink href="#/employees">社員一覧</BackLink>
      <TargetNotices targetId={emp.id} />

      <Card className="p-4 sm:p-6">
        <div className="flex items-start gap-4">
          <Avatar name={emp.name} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 sm:text-2xl dark:text-white">{emp.name}</h1>
              <EmployeeStatusBadge status={emp.status} />
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {dept?.name}
              {emp.position && `・${emp.position}`}
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>
            編集
          </Button>
          <Button variant="secondary" icon={Trash2} className="text-red-600 dark:text-red-400" onClick={() => setDeleteOpen(true)}>
            削除
          </Button>
          {emp.status !== 'retired' && (
            <Button icon={Zap} className="col-span-2" onClick={() => navigate(`/onboarding?employee=${emp.id}`)}>
              入社準備タスクを自動生成
            </Button>
          )}
        </div>

        <dl className="mt-5 grid grid-cols-1 gap-x-6 border-t border-slate-100 pt-4 sm:grid-cols-2 dark:border-navy-800">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-slate-100 py-2.5 text-sm sm:justify-start dark:border-navy-800">
              <dt className="w-24 shrink-0 text-slate-500 dark:text-slate-400">{k}</dt>
              <dd className="text-right font-medium text-slate-800 sm:text-left dark:text-slate-100">{v}</dd>
            </div>
          ))}
        </dl>
        {emp.notes && (
          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap text-slate-700 dark:bg-navy-950 dark:text-slate-300">
            <p className="mb-1 text-xs font-semibold text-slate-500">備考</p>
            {emp.notes}
          </div>
        )}
      </Card>

      <Card className="mt-4 overflow-hidden">
        <CardHeader
          title="関連タスク"
          icon={ClipboardList}
          description={tasks.length ? `完了 ${done} / ${tasks.length}件（${pct}%）` : undefined}
          action={
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setTaskCreating(true)}>
              追加
            </Button>
          }
        />
        {tasks.length > 0 && <ProgressBar value={pct} className="mx-4 mt-3 w-auto sm:mx-5" />}
        <div className="mt-2">
          {tasks.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="関連タスクはありません"
              description={emp.status === 'pending' ? '入社準備タスクを自動生成しましょう' : undefined}
            />
          ) : (
            <ul className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800">
              {tasks.map((t) => (
                <TaskItem key={t.id} task={t} onOpen={setTaskEditing} showEmployee={false} />
              ))}
            </ul>
          )}
        </div>
      </Card>

      <EmployeeEquipmentCard employeeId={emp.id} />
      <RelatedDocumentsCard filter={(d) => d.employeeId === emp.id} newHref={`#/documents/new?employee=${emp.id}`} title="関連書類（申請書など）" />

      <Card className="mt-4 overflow-hidden">
        <CardHeader
          title="この社員からの問い合わせ"
          icon={Headset}
          description={`${inquiries.length}件`}
          action={
            emp.status !== 'retired' && (
              <Button size="sm" variant="secondary" icon={Plus} onClick={() => navigate(`/helpdesk/new?requester=${emp.id}`)}>
                登録
              </Button>
            )
          }
        />
        {inquiries.length === 0 ? (
          <p className="px-5 pb-4 pt-2 text-sm text-slate-500">問い合わせはありません。</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800">
            {inquiries.map((i) => (
              <li key={i.id}>
                <a href={`#/helpdesk/${i.id}`} className="flex min-h-12 items-center gap-2 px-4 py-2 hover:bg-slate-50 sm:px-5 dark:hover:bg-navy-800/60">
                  <span className="font-mono text-[11px] text-slate-400">{i.number}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{i.title}</span>
                  <InquiryStatusBadge status={i.status} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <EmployeeFormModal open={editOpen} onClose={() => setEditOpen(false)} employee={emp} />
      <TaskFormModal open={taskCreating} onClose={() => setTaskCreating(false)} defaultEmployeeId={emp.id} />
      <TaskFormModal open={!!taskEditing} onClose={() => setTaskEditing(null)} task={taskEditing ?? undefined} />
      <ConfirmDialog
        open={deleteOpen}
        danger
        title="社員を削除しますか？"
        confirmLabel="削除する"
        message={
          <>
            <p>
              「{emp.name}（{emp.employeeNumber}）」を削除します。
            </p>
            {tasks.length > 0 && <p className="mt-2 font-semibold text-red-600 dark:text-red-400">関連するタスク {tasks.length}件も同時に削除されます。</p>}
            {inquiries.length > 0 && <p className="mt-2">問い合わせ {inquiries.length}件は履歴として残ります（受付時の氏名で表示）。</p>}
            <p className="mt-2 text-xs">退職の場合は削除せず、ステータスを「退職」に変更することをおすすめします。削除直後の通知から元に戻せます。</p>
          </>
        }
        onConfirm={async () => {
          await run((s) => s.deleteEmployee(emp.id), `${emp.name}さんを削除しました`, { undo: (d) => (s) => s.restoreEmployee(d) });
          navigate('/employees');
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </>
  );
}

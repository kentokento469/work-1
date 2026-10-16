/**
 * プロジェクト一覧: 完了率 (所属タスクの完了数 / 総数)・作成・編集・アーカイブ・削除。
 * 削除してもタスクは消さず、所属を外す (通知の「元に戻す」で再び所属させる)。
 */
import { useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, FolderKanban, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import type { Project } from '../../domain/types';
import { Modal, ModalCancelButton } from '../../ui/Modal';
import { Button, Card, EmptyState, TextAreaField, TextField } from '../../ui/primitives';
import { ProgressBar } from '../../ui/charts';
import { AppError } from '../../services/workcoreService';

export function projectProgress(tasks: { projectId?: string | null; status: string }[], id: string) {
  const own = tasks.filter((t) => t.projectId === id);
  const done = own.filter((t) => t.status === 'done').length;
  return { total: own.length, done, rate: own.length ? Math.round((done / own.length) * 100) : 0 };
}

export function ProjectFormModal({ open, onClose, project }: { open: boolean; onClose: () => void; project?: Project }) {
  const { run } = useAppData();
  const [name, setName] = useState(project?.name ?? '');
  const [desc, setDesc] = useState(project?.description ?? '');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await run((s) => s.tasks.saveProject({ name, description: desc }, project?.id), project ? 'プロジェクトを更新しました' : `プロジェクト「${name.trim()}」を作成しました`);
      onClose();
    } catch (err) {
      if (err instanceof AppError) setError(err.fieldErrors.name ?? err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} dirty={name !== (project?.name ?? '') || desc !== (project?.description ?? '')} title={project ? 'プロジェクトの編集' : 'プロジェクトの作成'} footer={<><ModalCancelButton /><Button type="submit" form="project-form" loading={busy} data-testid="project-save">{project ? '更新する' : '作成する'}</Button></>}>
      <form id="project-form" onSubmit={submit} noValidate className="space-y-3">
        <TextField label="プロジェクト名" required value={name} onChange={(e) => { setName(e.target.value); setError(undefined); }} error={error} maxLength={50} placeholder="例：社内PC入れ替え" />
        <TextAreaField label="説明" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} />
      </form>
    </Modal>
  );
}

export function ProjectsView({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const { data, run } = useAppData();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const list = data.projects.filter((p) => p.archived === showArchived).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const unassigned = data.tasks.filter((t) => !t.projectId && t.status !== 'done').length;
  return (
    <div data-testid="projects-view">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button icon={Plus} onClick={() => setEditing('new')} data-testid="project-new">
          プロジェクトを作成
        </Button>
        <label className="ml-auto inline-flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5 accent-navy-700" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          アーカイブ済みを表示
        </label>
      </div>
      {list.length === 0 ? (
        <Card>
          <EmptyState icon={FolderKanban} title={showArchived ? 'アーカイブ済みのプロジェクトはありません' : 'プロジェクトはまだありません'} description="複数のタスクをまとめて進捗を確認できます。プロジェクトに属さないタスクもそのまま使えます" />
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((p) => {
            const pr = projectProgress(data.tasks, p.id);
            return (
              <li key={p.id} data-testid="project-card" data-project-name={p.name}>
                <Card className="p-4">
                  <button type="button" className="w-full text-left" onClick={() => onOpenProject(p.id)}>
                    <p className="flex items-center gap-1.5 font-bold">
                      <FolderKanban className="size-4 text-navy-600" aria-hidden />
                      {p.name}
                    </p>
                    {p.description && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{p.description}</p>}
                    <div className="mt-2 flex items-center gap-2">
                      <ProgressBar value={pr.rate} className="flex-1" />
                      <span className="text-xs font-semibold tabular-nums" data-testid="project-progress">
                        {pr.rate}%（{pr.done}/{pr.total}）
                      </span>
                    </div>
                  </button>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(p)}>
                      編集
                    </Button>
                    <Button size="sm" variant="ghost" icon={p.archived ? ArchiveRestore : Archive} onClick={() => run((s) => s.tasks.setProjectArchived(p.id, !p.archived), p.archived ? 'アーカイブから戻しました' : 'アーカイブしました（タスクはそのまま残ります）').catch(() => undefined)} data-testid="project-archive">
                      {p.archived ? '戻す' : 'アーカイブ'}
                    </Button>
                    <Button size="sm" variant="ghost" icon={Trash2} className="text-red-600 dark:text-red-400" onClick={() => run((s) => s.tasks.deleteProject(p.id), (r) => `プロジェクト「${p.name}」を削除しました（タスク${r.taskIds.length}件は残し、所属を外しました）`, { undo: (r) => (s) => s.tasks.restoreProject(r) }).catch(() => undefined)} data-testid="project-delete">
                      削除
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 px-1 text-xs text-slate-500">プロジェクトに属さない未完了タスク：{unassigned}件（リスト表示で確認できます）</p>
      {editing && <ProjectFormModal open onClose={() => setEditing(null)} project={editing === 'new' ? undefined : editing} />}
    </div>
  );
}

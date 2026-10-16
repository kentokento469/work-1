/**
 * 詳細画面 (品目・発注書・書類など) の「関連タスク」。
 * 実際に作業が必要な場合だけ、利用者がタスクを作成する (通知や警告を自動でタスクにはしない)。
 * 作成したタスクは同じタスク管理で扱われ、タスクからこの画面へ戻れる (links)。
 */
import { useState } from 'react';
import { ClipboardList, Plus } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { isLinkedTo } from '../../domain/taskLinks';
import { compareDue } from '../../domain/tasks';
import type { Task, TaskLink } from '../../domain/types';
import type { TaskInput } from '../../domain/validation';
import { Button, Card, CardHeader } from '../../ui/primitives';
import { TaskFormModal } from '../TaskFormModal';
import { TaskItem } from '../TaskItem';

export function RelatedTasksCard({ link, suggestedTitle, defaults, description }: { link: TaskLink; suggestedTitle: string; defaults?: Partial<TaskInput>; description?: string }) {
  const { data } = useAppData();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const tasks = data.tasks.filter((t) => isLinkedTo(t, link.kind, link.id)).sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || compareDue(a, b));
  return (
    <Card className="mt-4" data-testid="related-tasks">
      <CardHeader
        title={`関連タスク（${tasks.filter((t) => t.status !== 'done').length}件未完了）`}
        icon={ClipboardList}
        description={description ?? '必要な作業をタスクとして登録し、タスク管理で進捗を管理できます'}
        action={
          <Button size="sm" variant="secondary" icon={Plus} onClick={() => setCreating(true)} data-testid="related-task-new">
            タスクを作成
          </Button>
        }
      />
      {tasks.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-navy-800">
          {tasks.map((t) => (
            <TaskItem key={t.id} task={t} onOpen={setEditing} />
          ))}
        </ul>
      )}
      <TaskFormModal open={creating} onClose={() => setCreating(false)} defaults={{ title: suggestedTitle, links: [link], ...defaults }} />
      <TaskFormModal open={!!editing} onClose={() => setEditing(null)} task={editing ?? undefined} />
    </Card>
  );
}

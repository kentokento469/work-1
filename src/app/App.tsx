import { AppDataProvider } from './AppData';
import { Layout } from './Layout';
import { useRoute } from './router';
import { ToastProvider } from '../ui/Toast';
import { DashboardPage } from '../pages/DashboardPage';
import { EmployeesPage } from '../pages/EmployeesPage';
import { EmployeeDetailPage } from '../pages/EmployeeDetailPage';
import { OnboardingPage } from '../pages/OnboardingPage';
import { TasksPage } from '../pages/TasksPage';
import { DataPage } from '../pages/DataPage';
import { EmptyState, Button } from '../ui/primitives';
import { FileQuestion } from 'lucide-react';

function Routes() {
  const route = useRoute();
  const [first, second] = route.segments;

  let active = 'dashboard';
  let page;
  switch (first) {
    case undefined:
      page = <DashboardPage />;
      break;
    case 'employees':
      active = 'employees';
      page = second ? <EmployeeDetailPage employeeId={second} /> : <EmployeesPage query={route.query} />;
      break;
    case 'onboarding':
      active = 'onboarding';
      page = <OnboardingPage query={route.query} />;
      break;
    case 'tasks':
      active = 'tasks';
      page = <TasksPage query={route.query} />;
      break;
    case 'data':
      active = 'data';
      page = <DataPage />;
      break;
    default:
      page = (
        <EmptyState
          icon={FileQuestion}
          title="ページが見つかりません"
          action={<Button onClick={() => (window.location.hash = '#/')}>ダッシュボードへ戻る</Button>}
        />
      );
  }
  return (
    <Layout active={active}>
      <div key={route.path} className="animate-fade-in">
        {page}
      </div>
    </Layout>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppDataProvider>
        <Routes />
      </AppDataProvider>
    </ToastProvider>
  );
}

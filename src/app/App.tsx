import { lazy, Suspense, useEffect } from 'react';
import { FileQuestion } from 'lucide-react';
import { AppDataProvider } from './AppData';
import { Layout } from './Layout';
import { useRoute } from './router';
import { ToastProvider } from '../ui/Toast';
import { DashboardPage } from '../pages/DashboardPage';
import { EmployeesPage } from '../pages/EmployeesPage';
import { EmployeeDetailPage } from '../pages/EmployeeDetailPage';
import { TasksPage } from '../pages/TasksPage';
import { MenuPage } from '../pages/MenuPage';
import { EmptyState, Button } from '../ui/primitives';

const loaders = {
  onboarding: () => import('../pages/OnboardingPage'),
  data: () => import('../pages/DataPage'),
  helpdesk: () => import('../pages/helpdesk/HelpdeskPage'),
  inquiryNew: () => import('../pages/helpdesk/InquiryNewPage'),
  inquiryDetail: () => import('../pages/helpdesk/InquiryDetailPage'),
  faq: () => import('../pages/helpdesk/FaqPages'),
  settings: () => import('../pages/settings/SettingsPage'),
  inventory: () => import('../pages/inventory/InventoryPage'),
  inventoryDetail: () => import('../pages/inventory/DetailPages'),
  automation: () => import('../pages/AutomationPage'),
};

// 使用頻度の低い画面・ヘルプデスクは初回表示を軽くするため遅延読み込みする
const OnboardingPage = lazy(() => loaders.onboarding().then((m) => ({ default: m.OnboardingPage })));
const DataPage = lazy(() => loaders.data().then((m) => ({ default: m.DataPage })));
const HelpdeskPage = lazy(() => loaders.helpdesk().then((m) => ({ default: m.HelpdeskPage })));
const InquiryNewPage = lazy(() => loaders.inquiryNew().then((m) => ({ default: m.InquiryNewPage })));
const InquiryDetailPage = lazy(() => loaders.inquiryDetail().then((m) => ({ default: m.InquiryDetailPage })));
const FaqListPage = lazy(() => loaders.faq().then((m) => ({ default: m.FaqListPage })));
const FaqDetailPage = lazy(() => loaders.faq().then((m) => ({ default: m.FaqDetailPage })));
const SettingsPage = lazy(() => loaders.settings().then((m) => ({ default: m.SettingsPage })));
const InventoryPage = lazy(() => loaders.inventory().then((m) => ({ default: m.InventoryPage })));
const ItemDetailPage = lazy(() => loaders.inventoryDetail().then((m) => ({ default: m.ItemDetailPage })));
const AssetDetailPage = lazy(() => loaders.inventoryDetail().then((m) => ({ default: m.AssetDetailPage })));
const OrderDetailPage = lazy(() => loaders.inventoryDetail().then((m) => ({ default: m.OrderDetailPage })));
const StocktakePage = lazy(() => loaders.inventoryDetail().then((m) => ({ default: m.StocktakePage })));
const AutomationPage = lazy(() => loaders.automation().then((m) => ({ default: m.AutomationPage })));

/** 初回表示の後、残りの画面を先読みして画面遷移時の読み込み待ち (ちらつき) をなくす */
function usePrefetchPages() {
  useEffect(() => {
    const t = setTimeout(() => Object.values(loaders).forEach((load) => load().catch(() => undefined)), 1500);
    return () => clearTimeout(t);
  }, []);
}

function Routes() {
  const route = useRoute();
  usePrefetchPages();
  const [first, second, third] = route.segments;

  let active = first ?? 'dashboard';
  let page;
  switch (first) {
    case undefined:
      page = <DashboardPage />;
      break;
    case 'employees':
      page = second ? <EmployeeDetailPage employeeId={second} /> : <EmployeesPage />;
      break;
    case 'helpdesk':
      page = second === 'new' ? <InquiryNewPage query={route.query} /> : second ? <InquiryDetailPage inquiryId={second} query={route.query} /> : <HelpdeskPage />;
      break;
    case 'faq':
      page = second ? <FaqDetailPage faqId={second} /> : <FaqListPage />;
      break;
    case 'onboarding':
      page = <OnboardingPage query={route.query} />;
      break;
    case 'tasks':
      page = <TasksPage query={route.query} />;
      break;
    case 'data':
      page = <DataPage />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    case 'menu':
      page = <MenuPage />;
      break;
    case 'inventory':
      page =
        second === 'items' && third ? (
          <ItemDetailPage itemId={third} />
        ) : second === 'assets' && third ? (
          <AssetDetailPage assetId={third} />
        ) : second === 'orders' && third ? (
          <OrderDetailPage orderId={third} />
        ) : second === 'stocktake' ? (
          <StocktakePage />
        ) : (
          <InventoryPage />
        );
      break;
    case 'automation':
      page = <AutomationPage />;
      break;
    default:
      active = 'dashboard';
      page = <EmptyState icon={FileQuestion} title="ページが見つかりません" action={<Button onClick={() => (window.location.hash = '#/')}>ダッシュボードへ戻る</Button>} />;
  }
  return (
    <Layout active={active}>
      <Suspense fallback={<div className="min-h-[50vh]" aria-busy="true" />}>
        <div key={route.path} className="animate-fade-in">
          {page}
        </div>
      </Suspense>
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

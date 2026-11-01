import { Box, CircularProgress } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, Navigate, Route, Routes, useLocation } from 'react-router';
import { setZone } from '#client/hooks/format.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { useVisit } from '#client/hooks/visit.ts';
import Header from './App/Header.tsx';
import Notifications from './App/Notifications.tsx';
import { useMe } from '#client/hooks/me.ts';
import EmployeePage from './EmployeePage.tsx';
import HelpPage from './HelpPage.tsx';
import EmailConfirmPage from './EmailConfirmPage.tsx';
import LoginCallbackPage from './LoginCallbackPage.tsx';
import OutsideDomainsPage from './OutsideDomainsPage.tsx';
import LoginPage from './LoginPage.tsx';
import SsoConfirmPage from './SsoConfirmPage.tsx';
import SsoEmailPage from './SsoEmailPage.tsx';
import MyDayPage from './MyDayPage.tsx';
import NewTaskPage from './NewTaskPage.tsx';
import TaskPage from './TaskPage.tsx';

// Screens of the signed-in employee. There is one — My day (decision 31);
// a task and a person open over it by route. `label` is a translation key
// for the window title.
const pages = [
  { path: '/', component: MyDayPage, label: 'nav.myDay' },
] as const;

type PagePath = (typeof pages)[number]['path'];

export default function () {
  const { pathname } = useLocation();
  const trpc = useTRPC();
  const { i18n } = useTranslation();
  const me = useQuery(trpc.Auth.me.queryOptions());

  // Interface language follows the employee's profile.
  useEffect(() => {
    if (me.data && i18n.language !== me.data.locale) void i18n.changeLanguage(me.data.locale);
  }, [me.data, i18n]);

  // Moments are shown in the profile's time zone (decision 99): set before anything renders them.
  if (me.data) setZone(me.data.timeZone);

  if (me.isPending) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <CircularProgress />
      </Box>
    );
  }

  // A link from a new address confirms it whoever is signed in here, or nobody.
  if (matchPath('/email/:token', pathname)) {
    return (
      <>
        <Notifications />
        <Routes><Route path="/email/:token" element={<EmailConfirmPage />} /></Routes>
      </>
    );
  }

  // A sign-in link works even when someone is signed in here: it switches
  // to the person it was sent to (My day mounts afresh after it).
  if (matchPath('/login/:token', pathname)) {
    return (
      <>
        <Notifications />
        <Routes><Route path="/login/:token" element={<LoginCallbackPage />} /></Routes>
      </>
    );
  }

  // So does the link that confirms the email of a first sign-in through the provider.
  if (matchPath('/sso/:token', pathname)) {
    return (
      <>
        <Notifications />
        <Routes><Route path="/sso/:token" element={<SsoConfirmPage />} /></Routes>
      </>
    );
  }

  return (
    <>
      <Notifications />
      {me.data?.outsideDomains ? (
        <OutsideDomainsPage />
      ) : me.data ? (
        <SignedIn />
      ) : (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/login/:token" element={<LoginCallbackPage />} />
          <Route path="/sso" element={<SsoEmailPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      )}
    </>
  );
}

function SignedIn() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const { pathname } = useLocation();
  const employees = useQuery(trpc.Employee.list.queryOptions());
  const active = pages.find((p) => p.path === pathname);
  const activePath = active?.path;
  // A task, a new task or an employee opens over the sections; they stay mounted underneath.
  const newTask = !!matchPath('/tasks/new', pathname);
  const taskId = Number(matchPath('/tasks/:id', pathname)?.params.id) || null;
  const employeeId = Number(matchPath('/employees/:id', pathname)?.params.id) || null;
  const help = !!matchPath('/help', pathname);
  const employeeName = employees.data?.find((e) => e.id === employeeId)?.fullName;
  // Every screen opened is a visit: a task with its number, any other without (decision 27).
  useVisit(taskId, true, pathname);

  useEffect(() => {
    const name = t('app.name');
    document.title = newTask ? `${name}: ${t('newTask.title')}`
      : taskId ? `${name}: ${t('task.title', { id: taskId })}`
      : employeeId ? `${name}: ${employeeName ?? ''}`
      : help ? `${name}: ${t('nav.help')}`
      : active ? `${name}: ${t(active.label)}` : name;
  }, [active, newTask, taskId, employeeId, employeeName, help, t]);

  // A page is mounted on first visit and then stays in the DOM to keep its state.
  const [loaded, setLoaded] = useState<Partial<Record<PagePath, true>>>({});
  useEffect(() => {
    if (activePath && !loaded[activePath]) setLoaded((prev) => ({ ...prev, [activePath]: true }));
  }, [activePath, loaded]);

  if (!activePath && !newTask && !taskId && !employeeId && !help) return <Navigate to={pages[0].path} replace />;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Header />
      {pages.map(
        ({ path, component: Page }) =>
          loaded[path] && (
            <Box
              component="main"
              key={path}
              sx={{ display: activePath === path ? 'flex' : 'none', flexGrow: 1, p: 2, overflow: 'auto' }}
            >
              <Page />
            </Box>
          ),
      )}
      {newTask && (
        <Box component="main" sx={{ display: 'flex', flexGrow: 1, p: 2, overflow: 'auto' }}>
          <NewTaskPage />
        </Box>
      )}
      {taskId && (
        <Box component="main" sx={{ display: 'flex', flexGrow: 1, p: 2, overflow: 'auto' }}>
          <TaskPage key={taskId} id={taskId} />
        </Box>
      )}
      {employeeId && (
        <Box component="main" sx={{ display: 'flex', flexGrow: 1, p: 2, overflow: 'auto' }}>
          <EmployeePage key={employeeId} id={employeeId} />
        </Box>
      )}
      {help && (
        <Box component="main" sx={{ display: 'flex', flexGrow: 1, p: 2, overflow: 'auto' }}>
          <HelpPage />
        </Box>
      )}
    </Box>
  );
}

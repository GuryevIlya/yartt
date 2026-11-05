import { CssBaseline, ThemeProvider } from '@mui/material';
import { focusManager, MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, createTRPCUntypedClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import superjson from 'superjson';
import type { AppRouter } from '#shared/types.ts';
import App from './components/App.tsx';
import { offlineLink, restoreCache, startOffline, unreachable } from './hooks/offline.ts';
import { showError } from './hooks/store.ts';
import { BASE, url } from './hooks/base.ts';
import { TRPCProvider } from './hooks/trpc.ts';
import './i18n/index.ts';
import theme from './theme.ts';

// Queries go in batches. A change goes alone, with its id: sent again by the
// outbox, the server knows it applied it already (decision 103).
const http = () => splitLink<AppRouter>({
  condition: (op) => op.type === 'mutation',
  true: httpLink({
    url: url('/api/trpc'),
    transformer: superjson,
    headers: ({ op }) => (typeof op.context.changeId === 'string' ? { 'x-yartt-change': op.context.changeId } : {}),
  }),
  false: httpBatchLink({ url: url('/api/trpc'), transformer: superjson }),
});
// Offline, a change goes to the outbox and is sent later by the plain client (decision 43).
const trpcClient = createTRPCClient<AppRouter>({ links: [offlineLink(), http()] });
// The outbox sends by path, so it needs the untyped client.
const outboxClient = createTRPCUntypedClient<AppRouter>({ links: [http()] });

// Every failed query and mutation shows a translated snackbar — except a
// refresh in the background the server did not answer (a proxy cutting it
// off, a moment without network): what is shown stays, and the next poll
// tries again; and anything not answered offline, which the top line already
// says. A server that is not reached is asked twice more first.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // A query that may fail by design (for the signed-in only, shown when allowed) says so: meta: { quiet: true }.
    onError: (error, query) => {
      if (query.meta?.quiet) return;
      if (!(unreachable(error) && (query.state.data !== undefined || !navigator.onLine))) showError(error);
    },
  }),
  // A mutation that shows its error itself says so: meta: { quiet: true }.
  // Offline, one that does not wait in the outbox (a visit) fails quietly too.
  mutationCache: new MutationCache({
    onError: (error, _v, _c, mutation) => {
      if (!mutation.meta?.quiet && !(unreachable(error) && !navigator.onLine)) showError(error);
    },
  }),
  defaultOptions: {
    queries: { retry: (count, error) => count < 2 && unreachable(error), refetchOnWindowFocus: true },
    // Mutations always reach the links: the offline link decides what waits.
    mutations: { retry: false, networkMode: 'always' },
  },
});

// Back to a window, the data is asked again. A tab and the installed app side
// by side are both visible all along: going from one to the other is a focus,
// which React Query alone does not notice.
focusManager.setEventListener((handleFocus) => {
  const onFocus = () => handleFocus();
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
  };
});

restoreCache(queryClient);
startOffline(outboxClient, queryClient);
if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register(url('/sw.js'));
// Opened past its path (the container's own port, not the address people use).
if (!window.location.pathname.startsWith(BASE)) window.location.replace(url('/'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <BrowserRouter basename={BASE || '/'}>
            <CssBaseline />
            <App />
          </BrowserRouter>
        </TRPCProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);

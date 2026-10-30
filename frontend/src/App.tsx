import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router'
import { AuthProvider, useAuth } from './app/AuthContext'
import { Layout } from './app/Layout'
import { SyncProvider } from './app/SyncContext'
import { storedTheme, useThemeSync } from './app/theme'
import { Spinner } from './components/States'
import { ToastProvider } from './components/Toast'
import { ApiError } from './lib/api'
import { LoginPage, RegisterPage } from './pages/AuthPages'
import { TodayPage } from './pages/TodayPage'

// Less frequently used pages are split into separate chunks.
const TasksPage = lazy(() => import('./pages/TasksPage').then((m) => ({ default: m.TasksPage })))
const PlannerPage = lazy(() => import('./pages/PlannerPage').then((m) => ({ default: m.PlannerPage })))
const GoalsPage = lazy(() => import('./pages/GoalsPage').then((m) => ({ default: m.GoalsPage })))
const InsightsPage = lazy(() => import('./pages/InsightsPage').then((m) => ({ default: m.InsightsPage })))
const HistoryPage = lazy(() => import('./pages/HistoryPage').then((m) => ({ default: m.HistoryPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // Client errors (4xx) are not transient; don't hammer the server with retries.
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
})

function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-ink-3">That page doesn't exist.</p>
      <Link to="/" className="btn-primary mt-6">
        Go to Today
      </Link>
    </div>
  )
}

function Routed() {
  const { status, user } = useAuth()
  useThemeSync(user?.theme ?? storedTheme())

  if (status === 'loading') return <Spinner label="Starting LifeOS" />
  if (status === 'anonymous' || !user) {
    return (
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    )
  }
  return (
    <SyncProvider userId={user.id}>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<TodayPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="planner" element={<PlannerPage />} />
            <Route path="goals" element={<GoalsPage />} />
            <Route path="insights" element={<InsightsPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="login" element={<Navigate to="/" replace />} />
            <Route path="register" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </SyncProvider>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routed />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}

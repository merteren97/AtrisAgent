import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/layout/app-shell';
import { Sidebar } from '@/components/layout/sidebar';
import { Titlebar } from '@/components/layout/titlebar';
import { ChatTimeline } from '@/components/chat/chat-timeline';
import { ChatComposer } from '@/components/composer/chat-composer';
import { OnboardingModal } from '@/components/onboarding/OnboardingModal';
import { InspectorPanel } from '@/components/inspector/inspector-panel';
import { initEventListener, reconnectEventListener } from '@/lib/event-listener';
import { checkApiHealth } from '@/lib/api-client';
import { recoverRuntimeConnection } from '@/lib/runtime-config';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useMissionStore } from '@/stores/mission-store';
import { useSettingsStore } from '@/stores/settings-store';
import { ThemeProvider } from '@/components/theme-provider';
import { AnalyticsDashboard } from '@/components/analytics/Dashboard';
import { SettingsView } from '@/components/settings/SettingsView';
import { AccountsView } from '@/components/accounts/AccountsView';
import { AgentsView } from '@/components/agents/AgentsView';
import { ProjectsView } from '@/components/projects/ProjectsView';
import { CommandPalette } from '@/components/search/CommandPalette';
import { DeveloperConsole } from '@/components/developer/DeveloperConsole';
import { UpdateManager } from '@/components/update/UpdateManager';
import { useAccountStore } from '@/stores/account-store';
import { AuthSessionProvider, useAuthSession } from '@/lib/auth-session';
import { LoginView } from '@/components/auth/login-view';
import { AccessGate } from '@/components/auth/access-gate';
import { isTauriRuntime } from '@/lib/secure-storage';
import { Loader2 } from 'lucide-react';
import type { RuntimeBootstrap } from '@/lib/runtime-config';

const RUNTIME_HEALTH_INTERVAL_MS = 8_000;

function AuthLoadingView() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <div className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
        Restoring your AtrisHub session…
      </div>
    </main>
  );
}

function WorkspaceApp() {
  const { shellState, session, error, isLoggingIn, isLoggingOut, login, logout, retry } = useAuthSession();
  const fetchWorkspaces = useWorkspaceStore((state) => state.fetchWorkspaces);
  const fetchMissions = useMissionStore((state) => state.fetchMissions);
  const activeView = useSettingsStore((state) => state.activeView);

  useEffect(() => {
    if (shellState !== 'workspace') return undefined;
    const disposeEvents = initEventListener();
    void (async () => {
      await fetchWorkspaces();
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      await fetchMissions(workspaceId || undefined);
      await useAccountStore.getState().fetchAccounts();
    })();
    return disposeEvents;
  }, [fetchWorkspaces, fetchMissions, shellState, session.token]);

  useEffect(() => {
    if (shellState !== 'workspace') return undefined;
    let disposed = false;
    let timer: number | null = null;
    let probing = false;

    const schedule = () => {
      if (!disposed) timer = window.setTimeout(() => void probe(), RUNTIME_HEALTH_INTERVAL_MS);
    };

    const restoreClientState = async () => {
      await fetchWorkspaces();
      if (disposed) return;
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      await Promise.allSettled([
        fetchMissions(workspaceId || undefined),
        useAccountStore.getState().fetchAccounts(),
      ]);
    };

    const probe = async () => {
      if (disposed || probing) return;
      probing = true;
      try {
        await checkApiHealth();
        if (!disposed) useAccountStore.getState().setServiceOnline(true);
      } catch (healthError) {
        if (!disposed) useAccountStore.getState().setServiceOnline(false, healthError instanceof Error ? healthError.message : 'Local service health check failed.');
        try {
          const recovered = await recoverRuntimeConnection();
          if (disposed || recovered.status !== 'ready') return;
          await checkApiHealth();
          if (disposed) return;
          useAccountStore.getState().setServiceOnline(true);
          reconnectEventListener();
          await restoreClientState();
        } catch (recoveryError) {
          if (!disposed) useAccountStore.getState().setServiceOnline(false, recoveryError instanceof Error ? recoveryError.message : 'Local runtime recovery failed.');
        }
      } finally {
        probing = false;
        schedule();
      }
    };

    schedule();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [fetchMissions, fetchWorkspaces, shellState, session.token]);

  if (shellState === 'checking') return <AuthLoadingView />;
  if (shellState === 'signed-out') return <LoginView error={error} isLoading={isLoggingIn} onLogin={login} />;
  if (shellState === 'offline') {
    return <AccessGate session={session} offline error={error} isLoggingOut={isLoggingOut} onRetry={retry} onLogout={logout} />;
  }
  if (shellState === 'premium-required') {
    return <AccessGate session={session} error={error} isLoggingOut={isLoggingOut} onRetry={retry} onLogout={logout} />;
  }

  return (
    <>
      <OnboardingModal />
      <AppShell
        sidebar={<Sidebar />}
        main={
          <main className="flex-1 flex min-w-0 flex-col">
            <Titlebar />
            <CommandPalette />
            {activeView === 'dashboard' ? (
              <AnalyticsDashboard />
            ) : activeView === 'settings' ? (
              <SettingsView />
            ) : activeView === 'accounts' ? (
              <AccountsView />
            ) : activeView === 'agents' ? (
              <AgentsView />
            ) : activeView === 'projects' ? (
              <ProjectsView />
            ) : (
              <>
                <ChatTimeline />
                <ChatComposer />
              </>
            )}
            <DeveloperConsole />
          </main>
        }
        inspector={activeView === 'chat' ? <InspectorPanel /> : null}
      />
    </>
  );
}

function RuntimeStartupFailure({ error }: { error: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-destructive/30 bg-card p-7 shadow-xl" role="alert">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-destructive">Local runtime unavailable</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">AtrisAgent could not start</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          The packaged gateway did not become ready. Your AtrisHub credentials were not sent.
        </p>
        <p className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">{error}</p>
        <button
          type="button"
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => window.location.reload()}
        >
          Retry runtime startup
        </button>
      </section>
    </main>
  );
}

export default function App({ runtime }: { runtime: RuntimeBootstrap }) {
  const closeBehavior = useSettingsStore((state) => state.closeBehavior);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invoke('set_close_behavior', { behavior: closeBehavior }).catch((error) => {
      console.error('[AtrisAgent] Could not synchronize close behavior with the native shell.', error);
    });
  }, [closeBehavior]);

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <UpdateManager />
        {runtime.status === 'failed' ? (
          <RuntimeStartupFailure error={runtime.error} />
        ) : (
          <AuthSessionProvider>
            <WorkspaceApp />
          </AuthSessionProvider>
        )}
      </TooltipProvider>
    </ThemeProvider>
  );
}

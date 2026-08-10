import { ExternalLink, LogOut, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { SessionSnapshot } from '@/lib/auth-client';

interface AccessGateProps {
  session: SessionSnapshot;
  offline?: boolean;
  error: string | null;
  isLoggingOut: boolean;
  onRetry: () => Promise<void>;
  onLogout: () => Promise<void>;
}

function displayName(session: SessionSnapshot): string {
  return session.user?.name || session.user?.username || session.user?.email || 'AtrisHub account';
}

export function AccessGate({ session, offline = false, error, isLoggingOut, onRetry, onLogout }: AccessGateProps) {
  const title = offline ? 'AtrisAgent is offline' : 'Premium access required';
  const description = offline
    ? 'The local gateway could not verify this session. Reconnect it, then retry without signing out.'
    : 'This workspace is available to active Premium and Admin memberships.';
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground">
      <Card className="w-full max-w-lg border-border/80 shadow-xl shadow-black/10">
        <CardHeader className="gap-3">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="AtrisAgent" className="h-10 w-10 object-contain" draggable={false} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{displayName(session)}</p>
              <p className="truncate text-xs text-muted-foreground">{session.user?.email || 'AtrisHub account'}</p>
            </div>
            <Badge variant={offline ? 'warning' : 'outline'} className="ml-auto shrink-0">
              {offline ? 'Offline' : session.membership.plan || 'Free'}
            </Badge>
          </div>
          <div className="mt-3 flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-400">
            {offline ? <WifiOff className="h-5 w-5" aria-hidden="true" /> : <ShieldAlert className="h-5 w-5" aria-hidden="true" />}
          </div>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription className="leading-relaxed">{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void onRetry()} variant="default">
              <RefreshCw aria-hidden="true" /> Retry verification
            </Button>
            {!offline && (
              <Button variant="outline" asChild>
                <a href="https://atrishub.com/premium" target="_blank" rel="noreferrer">
                  Manage Premium <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            )}
            <Button onClick={() => void onLogout()} variant="outline" disabled={isLoggingOut}>
              <LogOut aria-hidden="true" /> {isLoggingOut ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

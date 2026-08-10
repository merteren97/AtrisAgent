import { useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface LoginViewProps {
  error: string | null;
  isLoading: boolean;
  onLogin: (email: string, password: string, remember: boolean) => Promise<void>;
}

export function LoginView({ error, isLoading, onLogin }: LoginViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    await onLogin(email.trim(), password, remember).catch(() => undefined);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-md" aria-labelledby="login-title">
        <div className="mb-7 flex items-center gap-3 px-1">
          <img src="/logo.svg" alt="AtrisAgent" className="h-10 w-10 object-contain" draggable={false} />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">AtrisAgent</p>
            <p className="text-sm text-muted-foreground">The agent workspace for your projects</p>
          </div>
        </div>
        <Card className="border-border/80 bg-card/95 shadow-xl shadow-black/10">
          <CardHeader className="gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <CardTitle id="login-title" className="text-xl">Sign in to AtrisAgent</CardTitle>
              <CardDescription className="mt-2 leading-relaxed">Use your AtrisHub account to access the desktop workspace.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <form className="space-y-5" onSubmit={(event) => void submit(event)}>
              <div className="space-y-2">
                <Label htmlFor="atris-email">Email</Label>
                <Input
                  id="atris-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                  required
                  disabled={isLoading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="atris-password">Password</Label>
                <Input
                  id="atris-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                  disabled={isLoading}
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                  disabled={isLoading}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                Remember me on this device
              </label>
              {error && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert" aria-live="polite">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}
              <Button type="submit" className="h-10 w-full" disabled={isLoading || !email.trim() || !password}>
                {isLoading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
                {isLoading ? 'Signing in…' : 'Continue securely'}
                {!isLoading && <ArrowRight className="ml-auto" aria-hidden="true" />}
              </Button>
              <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground">
                <LockKeyhole className="h-3 w-3" aria-hidden="true" />
                Remembered tokens use Windows DPAPI or the operating system credential store.
              </p>
            </form>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

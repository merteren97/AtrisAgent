import { useEffect, useMemo, useState } from 'react';
import type { AccountProfile, RuntimeType } from '@atris-agent-code/domain';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useAccountStore, type AuthFlowResult } from '@/stores/account-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import { cn } from '@/lib/utils';

const ROLES = ['Orchestrator', 'Builder', 'Reviewer', 'Researcher', 'QA'];

export function AccountsView() {
  const {
    accounts,
    runtimes,
    discoveredModels,
    loading,
    serviceOnline,
    error,
    fetchAccounts,
    discoverLocalClis,
    addProfile,
    beginAuthentication,
    pollAuthentication,
    authenticateProfile,
    refreshModels,
    logoutProfile,
    deleteProfile,
    toggleSchedulerAuto,
  } = useAccountStore();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [runtimeType, setRuntimeType] = useState<RuntimeType>('codex');
  const [profileName, setProfileName] = useState('');
  const [authMethod, setAuthMethod] = useState('');
  const [roles, setRoles] = useState<string[]>(ROLES);
  const [schedulerAuto, setSchedulerAuto] = useState(true);
  const [createdProfileId, setCreatedProfileId] = useState<string | null>(null);
  const [authFlow, setAuthFlow] = useState<AuthFlowResult | null>(null);
  const [secret, setSecret] = useState('');
  const [providerId, setProviderId] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  const selectedRuntime = runtimes.find((runtime) => runtime.runtimeType === runtimeType);
  const selectedMethods = selectedRuntime?.authMethods || [];
  const connectedCount = accounts.filter((account) => account.authStatus === 'connected').length;
  const modelsByProfile = useMemo(() => {
    const map = new Map<string, number>();
    for (const model of discoveredModels) map.set(model.accountProfileId, (map.get(model.accountProfileId) || 0) + 1);
    return map;
  }, [discoveredModels]);
  const antigravityRuntime = runtimes.find((runtime) => runtime.runtimeType === 'antigravity');
  const antigravityProfile = accounts.find((account) => account.runtimeType === 'antigravity');
  const antigravityModels = discoveredModels.filter((model) => model.runtimeType === 'antigravity');
  const liveAntigravityModels = antigravityModels.filter((model) => model.source === 'discovered' && model.available);
  const antigravityReady = Boolean(
    antigravityRuntime?.installation.installed
      && antigravityProfile?.authStatus === 'connected'
      && liveAntigravityModels.length > 0,
  );

  useEffect(() => {
    if (!selectedMethods.some((method) => method.id === authMethod)) setAuthMethod(selectedMethods[0]?.id || '');
  }, [authMethod, selectedMethods]);

  const notify = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(null), 4_000);
  };

  const openWizard = (type: RuntimeType) => {
    const runtime = runtimes.find((item) => item.runtimeType === type);
    setRuntimeType(type);
    setProfileName(`${runtime?.name || type} Profile ${accounts.filter((account) => account.runtimeType === type).length + 1}`);
    setAuthMethod(runtime?.authMethods[0]?.id || '');
    setRoles(ROLES);
    setSchedulerAuto(true);
    setCreatedProfileId(null);
    setAuthFlow(null);
    setSecret('');
    setProviderId(type === 'opencode' ? 'openai' : '');
    setDialogOpen(true);
  };

  const createAndConnect = async () => {
    setBusyAction('create');
    try {
      const runtime = runtimes.find((item) => item.runtimeType === runtimeType);
      if (!runtime?.installation.installed) throw new Error(`${runtime?.name || runtimeType} is not installed or could not be discovered.`);
      const profileMode = runtimeType === 'antigravity' || (runtimeType === 'opencode' && ['existing_cli', 'existing_store'].includes(authMethod)) ? 'shared_cli' : 'isolated';
      const profile = await addProfile('', runtimeType, profileName.trim(), undefined, authMethod, roles, schedulerAuto, profileMode);
      setCreatedProfileId(profile.id);
      if (!authMethod) return;
      const options: Record<string, unknown> = {};
      if (runtimeType === 'opencode' && !['existing_cli', 'existing_store'].includes(authMethod)) options.providerId = providerId.trim();
      if (authMethod.includes('api_key') || authMethod.includes('token') || authMethod.includes('secret')) options.secret = secret;
      const flow = await beginAuthentication(profile.id, authMethod, options);
      setAuthFlow(flow);
      notify(flow.status === 'completed' ? 'Account connected.' : 'Official authentication flow started.');
      if (flow.status === 'completed') await refreshModels(profile.id);
    } catch (cause: any) {
      notify(cause?.message || 'Profile creation failed.');
    } finally {
      setBusyAction(null);
    }
  };

  const checkAuth = async () => {
    if (!createdProfileId || !authFlow) return;
    setBusyAction('poll');
    try {
      const result = await pollAuthentication(createdProfileId, authFlow.authId);
      if (result.status === 'connected') {
        await refreshModels(createdProfileId);
        notify(result.message || 'Authentication verified and live model catalog refreshed.');
        setDialogOpen(false);
      } else {
        notify(result.message || `Current authentication status: ${result.status}`);
      }
    } catch (cause: any) {
      notify(cause?.message || 'Authentication check failed.');
    } finally { setBusyAction(null); }
  };

  const restartAuthentication = async () => {
    if (!createdProfileId || !authMethod) return;
    setBusyAction('restart-auth');
    try {
      const flow = await beginAuthentication(createdProfileId, authMethod, {});
      setAuthFlow(flow);
      notify(flow.status === 'failed' ? (flow.instructions || 'Authentication could not be started.') : 'The official sign-in window was opened again.');
    } catch (cause: any) {
      notify(cause?.message || 'Authentication could not be restarted.');
    } finally {
      setBusyAction(null);
    }
  };

  const runAction = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusyAction(key);
    try { await action(); notify(success); }
    catch (cause: any) { notify(cause?.message || 'Operation failed.'); }
    finally { setBusyAction(null); }
  };

  const continueAuthentication = async (profile: AccountProfile) => {
    const runtime = runtimes.find((item) => item.runtimeType === profile.runtimeType);
    const method = profile.authMethod || runtime?.authMethods[0]?.id;
    if (!method) {
      notify('The installed runtime did not expose an authentication method. Scan runtimes again.');
      return;
    }
    setBusyAction(`connect-${profile.id}`);
    try {
      const flow = await beginAuthentication(profile.id, method, {});
      setRuntimeType(profile.runtimeType);
      setProfileName(profile.profileName);
      setAuthMethod(method);
      setCreatedProfileId(profile.id);
      setAuthFlow(flow);
      setDialogOpen(true);
      notify(flow.instructions || 'Official authentication flow started.');
    } catch (cause: any) {
      notify(cause?.message || 'Authentication could not be started.');
    } finally {
      setBusyAction(null);
    }
  };

  const switchAntigravityAccount = async (profile: AccountProfile) => {
    setBusyAction(`switch-${profile.id}`);
    try {
      await logoutProfile(profile.id);
      const runtime = runtimes.find((item) => item.runtimeType === profile.runtimeType);
      const method = profile.authMethod || runtime?.authMethods[0]?.id || 'native_keyring';
      const flow = await beginAuthentication(profile.id, method, {});
      setRuntimeType(profile.runtimeType);
      setProfileName(profile.profileName);
      setAuthMethod(method);
      setCreatedProfileId(profile.id);
      setAuthFlow(flow);
      setDialogOpen(true);
      notify('The previous Antigravity keyring session was signed out. Complete Google Sign-In for the account you want to use.');
    } catch (cause: any) {
      notify(cause?.message || 'Antigravity account switching could not be started.');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-background p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6 pb-10">
        <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-primary">
              <ShieldCheck className="h-4 w-4" /> Local runtime control
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">CLI Runtimes & Accounts</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              AtrisAgent delegates authentication to each official CLI. Tokens are not copied into the app database, and models are shown only from live or clearly labelled cached catalogs.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn('gap-1.5', serviceOnline ? 'border-emerald-500/30 text-emerald-400' : 'border-rose-500/30 text-rose-400')}>
              <span className={cn('h-2 w-2 rounded-full', serviceOnline ? 'bg-emerald-400' : 'bg-rose-400')} />
              {serviceOnline ? 'Local service online' : 'Local service offline'}
            </Badge>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => runAction('scan', discoverLocalClis, 'Runtime scan completed.')}>
              <RefreshCw className={cn('mr-2 h-4 w-4', busyAction === 'scan' && 'animate-spin')} /> Scan runtimes
            </Button>
          </div>
        </header>

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>
          </div>
        )}

        <section aria-label="Antigravity readiness" className="rounded-xl border border-border/80 bg-card/50 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Antigravity readiness</h2>
              <p className="text-[11px] text-muted-foreground">Provider availability is shown separately from local API health.</p>
            </div>
            <Badge variant="outline" className={antigravityReady ? 'border-emerald-500/30 text-emerald-400' : 'border-amber-500/30 text-amber-300'}>
              {antigravityReady ? 'Ready to run' : 'Action needed'}
            </Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <ReadinessItem label="Local service" ready={serviceOnline} detail={serviceOnline ? 'Online' : 'Offline'} />
            <ReadinessItem label="AGY CLI" ready={Boolean(antigravityRuntime?.installation.installed)} detail={antigravityRuntime?.installation.version || 'Not detected'} />
            <ReadinessItem label="Authentication" ready={antigravityProfile?.authStatus === 'connected'} detail={antigravityProfile?.authStatus === 'connected' ? 'Connected' : 'Not connected'} />
            <ReadinessItem label="Live catalog" ready={liveAntigravityModels.length > 0} detail={liveAntigravityModels.length ? `${liveAntigravityModels.length} models` : 'Refresh required'} />
          </div>
        </section>

        <section className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {runtimes.map((runtime) => {
            const profileCount = accounts.filter((account) => account.runtimeType === runtime.runtimeType).length;
            return (
              <Card key={runtime.runtimeType} className="min-w-0 overflow-hidden border-border/80 bg-card/70">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
                      <RuntimeBrandIcon runtimeId={runtime.runtimeType} className="h-5 w-5" title={runtime.name} />
                    </div>
                    <Badge variant="outline" className={runtime.installation.installed ? 'border-emerald-500/30 text-emerald-400' : 'border-muted text-muted-foreground'}>
                      {runtime.installation.installed ? 'Installed' : 'Not found'}
                    </Badge>
                  </div>
                  <CardTitle className="pt-3 text-base">{runtime.name}</CardTitle>
                  <CardDescription className="min-h-9 break-all text-xs">{runtime.installation.path || runtime.installation.error || 'No installation details.'}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{runtime.installation.version || 'Version unavailable'}</span><span>{profileCount} profiles</span>
                  </div>
                  <Button className="w-full" size="sm" disabled={!runtime.installation.installed || (runtime.runtimeType === 'antigravity' && profileCount > 0)} onClick={() => openWizard(runtime.runtimeType)}>
                    <Plus className="mr-2 h-4 w-4" /> {runtime.runtimeType === 'opencode' ? 'Attach CLI' : runtime.runtimeType === 'antigravity' && profileCount > 0 ? 'OS session attached' : 'Add account'}
                  </Button>
                  {runtime.runtimeType === 'antigravity' && (
                    <p className="text-[10px] leading-relaxed text-muted-foreground">Antigravity currently exposes one active Windows Credential Manager session per Windows user. Use Switch account on the existing profile to sign out and authenticate another Google account.</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
          {!runtimes.length && !loading && (
            <Card className="col-span-full border-dashed"><CardContent className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">Start the local API service, then scan installed runtimes.</CardContent></Card>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div><h2 className="text-lg font-semibold">Account profiles</h2><p className="text-xs text-muted-foreground">{connectedCount} connected · {discoveredModels.length} catalog routes</p></div>
            <Button variant="ghost" size="sm" disabled={!connectedCount} onClick={() => runAction('all-models', () => refreshModels(), 'All connected model catalogs refreshed.')}>
              <Activity className="mr-2 h-4 w-4" /> Refresh catalogs
            </Button>
          </div>

          <div className="grid min-w-0 gap-3 xl:grid-cols-2">
            {accounts.map((profile) => {
              const runtime = runtimes.find((item) => item.runtimeType === profile.runtimeType);
              const connected = profile.authStatus === 'connected';
              return (
                <Card key={profile.id} className="overflow-hidden border-border/80">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
                          <RuntimeBrandIcon runtimeId={profile.runtimeType} className="h-5 w-5" title={runtime?.name || profile.runtimeType} />
                        </div>
                        <div className="min-w-0"><CardTitle className="truncate text-base">{profile.profileName}</CardTitle><CardDescription className="mt-1 truncate text-xs">{runtime?.name || profile.runtimeType} · {profile.integrationMode || 'Capability probe pending'}</CardDescription></div>
                      </div>
                      <StatusBadge status={profile.authStatus} />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 text-xs">
                      <Metric label="Version" value={profile.installedVersion || 'Unknown'} />
                      <Metric label="Models" value={String(modelsByProfile.get(profile.id) || profile.supportedModels.length)} />
                      <Metric label="Auth" value={profile.authMethod || 'Not selected'} />
                      <Metric label="Last verified" value={profile.lastVerifiedAt ? new Date(profile.lastVerifiedAt).toLocaleString() : 'Never'} />
                    </div>

                    {profile.statusMessage && <p className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">{profile.statusMessage}</p>}

                    <div className="flex flex-wrap gap-1.5">
                      {(profile.allowedRoles || []).map((role) => <Badge key={role} variant="secondary" className="text-[10px]">{role}</Badge>)}
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                      <div><div className="text-xs font-medium">Scheduler route</div><div className="text-[10px] text-muted-foreground">Allow automatic selection for approved roles.</div></div>
                      <Switch checked={profile.schedulerAuto ?? true} onCheckedChange={() => runAction(`scheduler-${profile.id}`, () => toggleSchedulerAuto(profile.id), 'Scheduler preference updated.')} />
                    </div>

                    <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
                      {!connected && (
                        <Button size="sm" onClick={() => void continueAuthentication(profile)} disabled={busyAction === `connect-${profile.id}`}>
                          {busyAction === `connect-${profile.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />} Continue sign-in
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => runAction(`verify-${profile.id}`, () => authenticateProfile(profile.id), 'Account verification completed.')}>
                        {busyAction === `verify-${profile.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />} Verify
                      </Button>
                      <Button size="sm" variant="outline" disabled={!connected} onClick={() => runAction(`models-${profile.id}`, () => refreshModels(profile.id), 'Model catalog refreshed.')}>
                        <RefreshCw className={cn('mr-2 h-4 w-4', busyAction === `models-${profile.id}` && 'animate-spin')} /> Models
                      </Button>
                      {connected && profile.runtimeType === 'antigravity' && <Button size="sm" variant="outline" disabled={busyAction === `switch-${profile.id}`} onClick={() => void switchAntigravityAccount(profile)}>{busyAction === `switch-${profile.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />} Switch account</Button>}
                      {connected && <Button size="sm" variant="ghost" onClick={() => runAction(`logout-${profile.id}`, () => logoutProfile(profile.id), 'Signed out through the runtime.')}><LogOut className="mr-2 h-4 w-4" /> {profile.runtimeType === 'opencode' && profile.profileMode === 'shared_cli' ? 'Detach' : 'Logout'}</Button>}
                      <Button size="sm" variant="ghost" className="ml-auto text-rose-400 hover:text-rose-300" onClick={() => runAction(`delete-${profile.id}`, () => deleteProfile(profile.id), 'Profile removed.')}><Trash2 className="mr-2 h-4 w-4" /> Remove</Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {!accounts.length && (
              <Card className="xl:col-span-2 border-dashed"><CardContent className="flex min-h-40 flex-col items-center justify-center gap-2 text-center"><KeyRound className="h-7 w-7 text-muted-foreground" /><div className="text-sm font-medium">No account profiles yet</div><p className="max-w-md text-xs text-muted-foreground">Choose an installed runtime above. OpenCode can attach to your existing CLI; other supported runtimes use their official sign-in or isolated profile flow.</p></CardContent></Card>
            )}
          </div>
        </section>
      </div>

      {feedback && !dialogOpen && (
        <div className="fixed bottom-5 right-5 z-[120] flex max-w-md items-start gap-2 rounded-xl border border-primary/30 bg-card px-4 py-3 text-sm shadow-2xl">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /><span>{feedback}</span>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl overflow-x-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><RuntimeBrandIcon runtimeId={runtimeType} className="h-5 w-5 text-primary" />Connect {selectedRuntime?.name || runtimeType}</DialogTitle>
            <DialogDescription>{runtimeType === 'opencode' && authMethod === 'existing_cli' ? 'Attach the OpenCode CLI configuration already used in your terminal and import its live model list.' : 'Authentication is performed by the official CLI. AtrisAgent stores profile metadata only.'}</DialogDescription>
          </DialogHeader>
          {!createdProfileId ? (
            <div className="space-y-5 py-2">
              <div className="space-y-2"><Label>Profile name</Label><Input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Personal subscription" /></div>
              <div className="space-y-2"><Label>Authentication method</Label><select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={authMethod} onChange={(event) => setAuthMethod(event.target.value)}>{selectedMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select>{selectedMethods.find((method) => method.id === authMethod)?.description && <p className="text-xs text-muted-foreground">{selectedMethods.find((method) => method.id === authMethod)?.description}</p>}</div>
              {runtimeType === 'opencode' && !['existing_cli', 'existing_store'].includes(authMethod) && <div className="space-y-2"><Label>OpenCode provider ID</Label><Input value={providerId} onChange={(event) => setProviderId(event.target.value)} placeholder="openai, anthropic, google, openrouter..." /><p className="text-[11px] text-muted-foreground">Use the provider ID returned by OpenCode's provider catalog. Authentication methods differ by provider.</p></div>}
              {(authMethod.includes('api_key') || authMethod.includes('token') || authMethod.includes('secret')) && <div className="space-y-2"><Label>Secret</Label><Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Passed directly to the CLI; not persisted by AtrisAgent" /><p className="text-[11px] text-amber-400">This value is sent once to the official runtime process. Do not use this flow until the local service is trusted and running on your machine.</p></div>}
              <div className="space-y-2"><Label>Allowed roles</Label><div className="flex flex-wrap gap-2">{ROLES.map((role) => <button type="button" key={role} onClick={() => setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role])} className={cn('rounded-lg border px-3 py-1.5 text-xs transition-colors', roles.includes(role) ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground')}>{role}</button>)}</div></div>
              <div className="flex items-center justify-between rounded-xl border border-border p-3"><div><div className="text-sm font-medium">Automatic scheduler selection</div><div className="text-xs text-muted-foreground">The scheduler may use this profile only for selected roles.</div></div><Switch checked={schedulerAuto} onCheckedChange={setSchedulerAuto} /></div>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="rounded-xl border border-primary/25 bg-primary/10 p-4"><div className="flex items-center gap-2 text-sm font-medium"><KeyRound className="h-4 w-4 text-primary" /> Official authentication started</div><p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{authFlow?.instructions || 'Follow the instructions shown by the runtime.'}</p></div>
              {authFlow?.url && <div className="rounded-xl border border-border p-3"><div className="mb-2 text-xs font-medium">Authorization URL</div><div className="flex gap-2"><Input readOnly value={authFlow.url} className="font-mono text-xs" /><Button variant="outline" size="icon" onClick={() => navigator.clipboard.writeText(authFlow.url!)}><Copy className="h-4 w-4" /></Button><Button variant="outline" size="icon" asChild><a href={authFlow.url} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a></Button></div></div>}
              {authFlow?.userCode && <div className="rounded-xl border border-border p-3"><div className="mb-2 text-xs font-medium">Device code</div><div className="flex items-center justify-between rounded-lg bg-muted px-4 py-3 font-mono text-lg tracking-widest"><span>{authFlow.userCode}</span><Button variant="ghost" size="icon" onClick={() => navigator.clipboard.writeText(authFlow.userCode!)}><Copy className="h-4 w-4" /></Button></div></div>}
              <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">The app never fabricates a successful connection. Verification runs against the installed CLI. Antigravity authentication must finish in the separate terminal window.</p>
                {runtimeType === 'antigravity' && <Button type="button" variant="outline" size="sm" disabled={busyAction === 'restart-auth'} onClick={() => void restartAuthentication()}>{busyAction === 'restart-auth' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}Reopen sign-in</Button>}
              </div>
            </div>
          )}
          {feedback && (
            <div className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-xs">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /><span className="whitespace-pre-wrap">{feedback}</span>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Close</Button>
            {!createdProfileId ? <Button disabled={!profileName.trim() || !authMethod || (runtimeType === 'opencode' && !['existing_cli', 'existing_store'].includes(authMethod) && !providerId.trim()) || busyAction === 'create'} onClick={createAndConnect}>{busyAction === 'create' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{runtimeType === 'opencode' && authMethod === 'existing_cli' ? 'Attach CLI' : 'Create & connect'}</Button> : <Button disabled={!authFlow || busyAction === 'poll'} onClick={checkAuth}>{busyAction === 'poll' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Check connection</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReadinessItem({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2">
      {ready ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : <XCircle className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
      <div className="min-w-0">
        <div className="truncate text-[11px] font-medium">{label}</div>
        <div className="truncate text-[10px] text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'connected') return <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-400"><CheckCircle2 className="mr-1 h-3 w-3" />Connected</Badge>;
  if (status === 'error' || status === 'rate_limited') return <Badge variant="outline" className="border-rose-500/30 text-rose-400"><XCircle className="mr-1 h-3 w-3" />{status.replace('_', ' ')}</Badge>;
  if (status.startsWith('awaiting')) return <Badge variant="outline" className="border-amber-500/30 text-amber-400"><Loader2 className="mr-1 h-3 w-3 animate-spin" />Waiting</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">{status.replaceAll('_', ' ')}</Badge>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div><div className="mt-1 truncate font-medium text-foreground" title={value}>{value}</div></div>;
}

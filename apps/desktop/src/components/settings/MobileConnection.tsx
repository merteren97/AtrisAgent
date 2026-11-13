import { useState } from 'react';
import { Smartphone } from 'lucide-react';
import { useAuthSession } from '@/lib/auth-session';
import { approveMobile, revokeMobile, startMobileHost, stopMobileHost, useMobileHost } from '@/lib/mobile-host';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function MobileConnection() {
  const { session } = useAuthSession();
  const state = useMobileHost();
  const [copyError, setCopyError] = useState('');
  return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Smartphone className="h-4 w-4" /> Mobile access</CardTitle><CardDescription>Connect your phone over the internet. Sign in to the same AtrisHub account on both devices. Keep this desktop app open.</CardDescription></CardHeader><CardContent className="space-y-4">
    <p role="status" className="text-sm text-muted-foreground">{state.status === 'online' ? 'Relay connected. Pairing codes expire after 10 minutes; approved phones stay connected until you revoke them or close the app.' : state.status === 'connecting' ? 'Connecting to relay…' : 'Remote access is off.'}</p>
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
    <div className="flex gap-2"><Button disabled={state.status === 'connecting' || !session.token} onClick={() => { if (session.token) void startMobileHost(session.token); }}>{state.status === 'online' ? 'New code (disconnect phones)' : 'Enable mobile access'}</Button>{state.status !== 'disabled' && <Button variant="outline" onClick={stopMobileHost}>Disable access</Button>}</div>
    {state.code && <div className="space-y-2"><label className="text-xs font-medium" htmlFor="pairing-code">Paste this private code into Mobile → Connect</label><textarea id="pairing-code" readOnly value={state.code} className="h-24 w-full break-all rounded-md border border-input bg-muted/30 p-3 font-mono text-xs" /><Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(state.code).catch(() => setCopyError('Select and copy the code manually.')); }}>Copy pairing code</Button>{copyError && <p className="text-xs">{copyError}</p>}</div>}
    {state.devices.map(device => <div key={device.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><div><p className="text-sm font-medium">{device.username} · Phone</p><p className="text-xs text-muted-foreground">{device.approved ? 'Can read agent conversations and send messages' : 'Approve only the phone you just paired'}</p></div><div className="flex gap-2">{!device.approved && <Button size="sm" onClick={() => approveMobile(device.id)}>Approve phone</Button>}<Button size="sm" variant="outline" onClick={() => revokeMobile(device.id)}>Disconnect</Button></div></div>)}
  </CardContent></Card>;
}

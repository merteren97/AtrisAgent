import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, FolderOpen, Layers3, LoaderCircle, Monitor, Plus, RefreshCw, Shield, Sparkles, UserRound, WifiOff, X } from 'lucide-react';
import { api, connectDesktop, disconnectDesktop, type Agent, type Message, type Model, type Session, type Workspace } from './api';
import { clearHubSession, loginHub, restoreHubSession, type HubAccount } from './hub-auth';
import logo from '../../desktop/public/logo.svg';
import { AgentControls } from './agent-controls';

const statusLabel: Record<Agent['status'], string> = { working: 'Working', waiting: 'Needs input', idle: 'Ready', offline: 'Offline', error: 'Needs attention', unknown: 'Open · status unavailable' };
function Brand() { return <div className="brand"><span className="brand-mark"><img src={logo} alt="AtrisAgent logo" /></span><span>Atris<span>Agent</span></span></div>; }
function Status({ status }: { status: Agent['status'] }) { return <span className={`status status-${status}`}><i />{statusLabel[status]}</span>; }
function Avatar({ name }: { name: string }) { return <span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>; }
function Sheet({ title, close, children }: { title: string; close(): void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea') || []);
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') { const items = focusable(); const first = items[0]; const last = items[items.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [close]);
  return <div className="sheet-overlay"><section ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={title}><div className="sheet-handle" /><div className="sheet-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close panel" onClick={close}><X size={20} /></button></div>{children}</section></div>;
}

export function App() {
  const [session, setSession] = useState<Session>({ connected: false });
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [screen, setScreen] = useState<'home' | 'workspace' | 'chat' | 'activity'>('home');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [deliveries, setDeliveries] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Model[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState('');
  const [account, setAccount] = useState<HubAccount | null>(null);
  const [panel, setPanel] = useState<'account' | 'connect' | 'models' | 'controls' | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [restoringAccount, setRestoringAccount] = useState(true);
  const [code, setCode] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const connectionEpoch = useRef(0);
  const refreshing = useRef<number | undefined>(undefined);
  const activeAgent = useRef(agentId);
  activeAgent.current = agentId;
  const workspace = workspaces.find(item => item.id === workspaceId);
  const agent = workspace?.agents.find(item => item.id === agentId);
  const draft = drafts[agentId] || '';
  const delivery = deliveries[agentId] || '';
  const setDelivery = (message: string) => setDeliveries(current => ({ ...current, [agentId]: message }));
  const closePanel = useCallback(() => { setPanel(null); setPassword(''); }, []);
  useEffect(() => {
    let active = true;
    void restoreHubSession().then(value => { if (active) setAccount(value); }).catch(() => { if (active) setAccountError('Saved session could not be restored. Sign in again.'); }).finally(() => { if (active) setRestoringAccount(false); });
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async () => {
    const epoch = connectionEpoch.current;
    if (refreshing.current === epoch) return;
    refreshing.current = epoch;
    try {
      const next = await api.session();
      const projects = next.connected ? await api.workspaces() : undefined;
      if (epoch !== connectionEpoch.current) return;
      setSession(next);
      if (projects) setWorkspaces(projects);
      setError('');
    } catch (cause) { if (epoch === connectionEpoch.current) { setSession({ connected: false }); setError(cause instanceof Error ? cause.message : 'Desktop is unavailable.'); } }
    finally { if (refreshing.current === epoch) refreshing.current = undefined; }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 4000);
    const offline = () => { connectionEpoch.current++; setSession({ connected: false }); setError('Desktop disconnected. Keep the desktop app open and reconnect.'); };
    window.addEventListener('desktop-disconnected', offline);
    const resume = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', resume);
    return () => { window.clearInterval(timer); window.removeEventListener('desktop-disconnected', offline); document.removeEventListener('visibilitychange', resume); };
  }, [refresh]);
  useEffect(() => {
    if (!session.connected || screen !== 'chat' || !agentId) return;
    let active = true; let busy = false;
    const load = async () => { if (busy) return; busy = true; try { const result = await api.messages(agentId); if (active) setMessages(result); } catch { if (active) setDelivery('Could not refresh this conversation.'); } finally { busy = false; } };
    void load(); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [agentId, screen, session.connected]);
  useEffect(() => { if (follow.current) endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const openAgent = (item: Agent, project = workspaceId) => { setWorkspaceId(project); setAgentId(item.id); setMessages([]); follow.current = true; setScreen('chat'); };
  const beginPair = () => { setConnectError(''); setPanel(account ? 'connect' : 'account'); };
  const pair = async () => {
    connectionEpoch.current++;
    setSession({ connected: false });
    setConnectBusy(true); setConnectError('');
    try { await connectDesktop(code); await refresh(); setCode(''); setPanel(null); setScreen('home'); }
    catch (cause) { setConnectError(cause instanceof Error ? cause.message : 'Connection failed.'); }
    finally { setConnectBusy(false); }
  };
  const signIn = async () => {
    if (restoringAccount || accountBusy) return;
    setAccountBusy(true); setAccountError('');
    try { setAccount(await loginHub(email, password)); setPassword(''); }
    catch (cause) { setAccountError(cause instanceof Error ? cause.message : 'Could not sign in.'); }
    finally { setAccountBusy(false); }
  };
  const unpair = () => { connectionEpoch.current++; disconnectDesktop(); setSession({ connected: false }); setWorkspaces([]); };
  const signOut = async () => { try { await clearHubSession(); unpair(); setAccount(null); setMessages([]); setEmail(''); setDrafts({}); setDeliveries({}); setScreen('home'); } catch { setAccountError('Could not clear the saved session. Please try again.'); } };
  const send = async () => {
    if (!agent || !workspace || !draft.trim() || sending || !session.connected) return;
    const submitted = draft; const target = agent.id;
    let accepted = false;
    setSending(true); setDelivery('');
    try {
      const result = await api.send(workspace.id, agent, submitted, crypto.randomUUID());
      if (result.status !== 'delivered') { setDelivery(result.status === 'unknown' ? 'Delivery could not be confirmed. Check before sending again.' : 'Desktop rejected the message. Your draft is kept.'); return; }
      accepted = true;
      setDrafts(current => current[target] === submitted ? { ...current, [target]: '' } : current);
      const updated = await api.messages(target);
      if (activeAgent.current === target) setMessages(updated);
    } catch { setDelivery(accepted ? 'Message delivered, but conversation history could not be refreshed.' : 'Delivery could not be confirmed. Your draft is kept; check before sending again.'); }
    finally { setSending(false); }
  };
  const openModels = async () => { if (!agent) return; setModels([]); setModelError(''); setPanel('models'); try { setModels(await api.models(agent.id)); } catch (cause) { setModelError(cause instanceof Error ? cause.message : 'Could not load models.'); } };
  const selectModel = async (model: Model, reasoning?: string) => {
    if (!agent || modelBusy) return; setModelBusy(true); setModelError('');
    try { await api.setModel(agent, model.id, reasoning); await refresh(); setPanel(null); }
    catch (cause) { setModelError(cause instanceof Error ? cause.message : 'Could not change the model.'); }
    finally { setModelBusy(false); }
  };
  const agents = (project: Workspace) => <div className="agent-list">{project.agents.map(item => <button className="agent-card" key={item.id} onClick={() => openAgent(item, project.id)}><div className="agent-card-top"><Avatar name={item.name} /><div className="agent-title"><strong>{item.name}</strong><span>{item.runtime} · {item.model}</span></div><ChevronRight size={18} /></div><p>{item.summary || 'Open this conversation to continue your work.'}</p><div className="agent-card-bottom"><Status status={item.status} /><span>Open conversation</span></div></button>)}{!project.agents.length && <p className="empty-state">No agents in this workspace yet. Open an agent on desktop.</p>}</div>;

  return <main className={`app-shell ${screen === 'chat' && agent ? 'chat-shell' : ''}`}>
    {screen === 'chat' && agent && workspace ? <>
      <header className="chat-header"><button className="icon-button" aria-label="Back to workspace" onClick={() => setScreen('workspace')}><ArrowLeft size={20} /></button><Avatar name={agent.name} /><div className="header-title"><strong>{agent.name}</strong><Status status={session.connected ? agent.status : 'offline'} /></div><button className="icon-button" aria-label="Refresh conversation" onClick={() => void api.messages(agent.id).then(setMessages).catch(() => setDelivery('Could not refresh conversation.'))}><RefreshCw size={18} /></button></header>
      <div className="chat-context"><FolderOpen size={14} />{workspace.name}<ChevronRight size={13} />{agent.runtime}</div>
      <section className="chat-scroll" aria-label="Conversation" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 100; }}>
        <div className="conversation-intro"><div className="intro-icon"><img src={logo} alt="" /></div><strong>{session.connected ? `Connected to ${agent.name}` : 'Desktop disconnected'}</strong><p>The conversation runs on your desktop.</p></div>
        {messages.map(message => <article className={`message message-${message.role}`} key={message.id}>{message.role !== 'user' && <Avatar name={agent.name} />}<div className="message-content"><div className="message-meta"><strong>{message.role === 'user' ? 'You' : message.role === 'tool' ? 'Activity' : agent.name}</strong></div><div className="message-text">{message.text}</div></div></article>)}<div ref={endRef} />
      </section>
      <div className="composer-wrap">{delivery && <p role="alert" className="inline-error">{delivery}</p>}<div className="composer"><textarea aria-label={`Message ${agent.name}`} value={draft} maxLength={32000} placeholder="Send a message…" onChange={event => setDrafts(current => ({ ...current, [agent.id]: event.target.value }))} /><div className="composer-actions"><button className="model-button" onClick={() => void openModels()} disabled={!session.connected}><span className="model-dot" /><span>{agent.model}</span><small>· {agent.reasoning || 'default'}</small><ChevronDown size={14} /></button><button className="icon-button" aria-label="Agent permissions, questions and memory" disabled={!session.connected} onClick={() => setPanel('controls')}><Shield size={18} /></button><button className="send-button" aria-label="Send message" disabled={!draft.trim() || sending || !session.connected || agent.status === 'offline'} onClick={() => void send()}>{sending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={20} />}</button></div></div><p className="composer-hint"><Shield size={11} /> Encrypted connection · Runs on your desktop</p></div>
    </> : <>
      <header className="topbar"><Brand /><div className="header-actions"><button className="account-button" aria-label={account ? 'AtrisHub account' : 'Sign in to AtrisHub'} onClick={() => setPanel('account')}><UserRound size={17} /><span>{account?.username || 'Sign in'}</span></button><button className="desktop-pill" aria-label="Refresh desktop connection" onClick={() => void refresh()}><i className={session.connected ? 'online' : ''} />{session.connected ? 'Connected' : session.pendingApproval ? 'Approval' : 'Offline'}</button></div></header>
      {!session.connected ? <div className="offline-state"><div className="offline-graphic"><Monitor size={30} /><span><WifiOff size={18} /></span></div><span className="eyebrow">YOUR WORKSPACE, WHEREVER YOU ARE</span><h1>Stay close to<br />your work.</h1><p>Connect to your desktop to follow agents and continue conversations, even on a different network.</p><div className="offline-notice"><CircleAlert size={18} /><div><strong>{session.pendingApproval ? 'Approve your phone on desktop' : 'Desktop not connected'}</strong><p>{session.pendingApproval ? 'In desktop Settings → Mobile access, choose Approve phone.' : error || 'Sign in, then paste a pairing code from desktop Settings → Mobile access.'}</p></div></div><button className="primary-button" onClick={beginPair}>{account ? 'Connect desktop' : 'Sign in to get started'}</button><p className="offline-caption">Both devices must use the same AtrisHub account.</p></div> : <section className="page">
        {screen === 'home' ? <><div className="page-heading"><span className="eyebrow">YOUR DESKTOP, IN YOUR POCKET</span><h1>Your workspaces<span className="accent">.</span></h1><p>Pick up where you left off.</p></div><div className="connection-card"><span className="connection-icon"><Monitor size={20} /></span><div><strong>{session.desktopName || 'Your desktop'}</strong><p><i /> Connected and ready</p></div></div><div className="section-heading"><h2>Workspaces <span>{workspaces.length}</span></h2><button className="icon-button" aria-label="Refresh workspaces" onClick={() => void refresh()}><RefreshCw size={17} /></button></div><label className="search"><Sparkles size={17} /><input aria-label="Find a workspace" placeholder="Find a workspace" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="workspace-list">{workspaces.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map(item => <button className="workspace-card" key={item.id} onClick={() => { setWorkspaceId(item.id); setScreen('workspace'); }}><span className="workspace-icon"><FolderOpen size={20} /></span><span className="workspace-info"><strong>{item.name}</strong><small>{item.agents.length} agents</small></span><ChevronRight size={18} /></button>)}</div></> : screen === 'activity' ? <><div className="page-heading"><h1>Your agents</h1><p>Live conversations across your desktop workspaces.</p></div>{workspaces.map(project => <section key={project.id}><div className="section-heading"><h2>{project.name}</h2></div>{agents(project)}</section>)}</> : workspace && <><button className="back-link" onClick={() => setScreen('home')}><ArrowLeft size={16} />All workspaces</button><div className="workspace-hero"><span className="workspace-icon hero-icon"><FolderOpen size={24} /></span><div><span className="eyebrow">WORKSPACE</span><h1>{workspace.name}</h1><p>Continue a conversation with your agents.</p></div></div><div className="section-heading"><h2>Agents <span>{workspace.agents.length}</span></h2></div>{agents(workspace)}</>}
      </section>}
      <nav className="bottom-nav" aria-label="Main navigation"><button className={screen === 'home' || screen === 'workspace' ? 'nav-active' : ''} onClick={() => setScreen('home')}><Layers3 size={20} /><span>Workspaces</span></button><button onClick={() => setScreen('activity')} disabled={!session.connected}><Clock3 size={20} /><span>Activity</span></button><button onClick={beginPair}><Plus size={20} /><span>Connect</span></button></nav>
    </>}
    {panel === 'account' && <Sheet title={account ? 'Your account' : 'Welcome back'} close={closePanel}>
      {account ? <>
        <p>Signed in as <strong>{account.name || account.username}</strong>.</p>
        <div className="account-notice"><Shield size={17} /><span>Connect using a private pairing code and approve your phone on the desktop. Both devices must use this account.</span></div>
        <p className="account-note">{account.persistent ? 'Session saved in native secure storage.' : 'Session is not saved. Sign in again after restarting the app.'}</p>
        {accountError && <p role="alert" className="sheet-error">{accountError}</p>}
        <button className="primary-button" onClick={() => setPanel('connect')}>Connect desktop</button>
        <button className="account-secondary" onClick={() => void signOut()}>Sign out</button>
      </> : <>
        <p>Use the AtrisHub account you use on your desktop.</p>
        <form className="account-form" onSubmit={event => { event.preventDefault(); void signIn(); }}>
          <label>Email or username<input autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
          {accountError && <p role="alert" className="sheet-error">{accountError}</p>}
          <button className="primary-button" disabled={restoringAccount || accountBusy || !email.trim() || !password}>{restoringAccount ? 'Restoring session…' : accountBusy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="account-note">Credentials are sent only to AtrisHub over HTTPS.</p>
      </>}
    </Sheet>}
    {panel === 'connect' && <Sheet title="Connect your desktop" close={closePanel}><p>On your computer, open Settings → Mobile access. Enable access and paste its private pairing code here.</p><form className="account-form" onSubmit={event => { event.preventDefault(); void pair(); }}><label>Pairing code<textarea required value={code} spellCheck={false} onChange={event => setCode(event.target.value)} /></label>{connectError && <p role="alert" className="sheet-error">{connectError}</p>}<button className="primary-button" disabled={connectBusy || !code.trim()}>{connectBusy ? 'Connecting…' : 'Connect desktop'}</button></form><p className="account-note">Approve your phone on desktop after connecting. Your computer must remain open and online.</p><button className="account-secondary" onClick={unpair}>Disconnect desktop</button></Sheet>}
    {panel === 'controls' && agent && <Sheet title="Agent controls" close={closePanel}><AgentControls agentId={agent.id} /></Sheet>}
    {panel === 'models' && agent && <Sheet title="Model & reasoning" close={closePanel}><p>Available models on this agent's desktop account. Non-OpenCode sessions restart when idle; an active turn cannot be interrupted here.</p>{modelError && <p role="alert" className="sheet-error">{modelError}</p>}<div className="model-list">{models.map(model => <div className="model-item" key={model.id}><button disabled={!model.available || modelBusy} onClick={() => void selectModel(model, model.reasoning[0])}><span className="model-icon"><Sparkles size={16} /></span><span><strong>{model.name}</strong><small>{model.runtime}</small></span>{model.selected && <Check size={17} />}</button>{model.selected && <div className="reasoning"><span>REASONING</span><div>{model.reasoning.map(level => <button disabled={modelBusy} key={level} className={agent.reasoning === level ? 'selected' : ''} onClick={() => void selectModel(model, level)}>{level}</button>)}</div></div>}</div>)}{!models.length && !modelError && <p className="empty-state">Loading models…</p>}</div></Sheet>}
  </main>;
}

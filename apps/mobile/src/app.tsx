import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Bot, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, FolderOpen, Layers3, LoaderCircle, Monitor, MoreHorizontal, Plus, RefreshCw, Search, Shield, Sparkles, WifiOff, X } from 'lucide-react';
import { api, type Agent, type Message, type Model, type Session, type Workspace } from './api';
import atrisLogo from '../../desktop/public/logo.svg';

type Screen = 'home' | 'workspace' | 'chat';
const statusLabel: Record<Agent['status'], string> = { working: 'Working', waiting: 'Needs input', idle: 'Ready', offline: 'Offline', error: 'Needs attention' };

function Brand() { return <span className="brand-mark"><img src={atrisLogo} alt="AtrisAgent logo" /></span>; }
function Status({ status }: { status: Agent['status'] }) { return <span className={`status status-${status}`}><i />{statusLabel[status]}</span>; }
function Avatar({ name, large = false }: { name: string; large?: boolean }) { return <span className={`avatar ${large ? 'avatar-large' : ''}`} aria-hidden="true">{name.trim().slice(0, 1).toUpperCase() || 'A'}</span>; }

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [agentId, setAgentId] = useState<string>();
  const [screen, setScreen] = useState<Screen>('home');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [deliveryError, setDeliveryError] = useState('');
  const [modelsOpen, setModelsOpen] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [modelError, setModelError] = useState('');
  const [modelBusy, setModelBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const workspace = workspaces.find(item => item.id === workspaceId);
  const agent = workspace?.agents.find(item => item.id === agentId);
  const connected = Boolean(session?.connected);
  const draft = agentId ? drafts[agentId] || '' : '';

  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const current = await api.session();
      setSession(current);
      if (current.connected) setWorkspaces(await api.workspaces());
      else setWorkspaces([]);
      setError('');
    } catch {
      setSession({ connected: false });
      setError('Desktop connection is unavailable.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(true); }, [refresh]);
  useEffect(() => {
    if (!connected || screen !== 'chat' || !agentId) return;
    let active = true;
    const load = async () => { try { const next = await api.messages(agentId); if (active) setMessages(next); } catch { if (active) setDeliveryError('Could not refresh this conversation.'); } };
    setMessages([]); void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [agentId, connected, screen]);
  useEffect(() => { if (screen === 'chat') endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, screen]);

  const openAgent = (item: Agent) => { setAgentId(item.id); setMessages([]); setDeliveryError(''); setScreen('chat'); };
  const send = async () => {
    if (!agent || !workspace || !draft.trim() || sending || !connected || agent.status === 'offline') return;
    const submitted = draft;
    setSending(true); setDeliveryError('');
    try {
      const result = await api.send(workspace.id, agent, submitted.trim(), crypto.randomUUID());
      if (result.status !== 'delivered') { setDeliveryError('Delivery could not be confirmed. Check the conversation before sending again.'); return; }
      setDrafts(current => current[agent.id] === submitted ? { ...current, [agent.id]: '' } : current);
      try { setMessages(await api.messages(agent.id)); } catch { setDeliveryError('Message delivered, but the conversation could not be refreshed.'); }
    } catch { setDeliveryError('Delivery could not be confirmed. Your draft is kept; check before sending again.'); }
    finally { setSending(false); }
  };
  const openModels = async () => {
    if (!agent) return;
    setModelsOpen(true); setModels([]); setModelError('');
    try { setModels(await api.models(agent.id)); } catch { setModelError('Models could not be loaded.'); }
  };
  const selectModel = async (model: Model, reasoning?: string) => {
    if (!agent || !workspace || modelBusy) return;
    setModelBusy(true); setModelError('');
    try {
      const updated = await api.setModel(agent, model.id, reasoning);
      setWorkspaces(current => current.map(item => item.id === workspace.id ? { ...item, agents: item.agents.map(value => value.id === agent.id ? updated : value) } : item));
      setModelsOpen(false);
    } catch { setModelError('Could not update the model. Check the desktop and try again.'); }
    finally { setModelBusy(false); }
  };

  return <main className={`app-shell ${screen === 'chat' && agent && workspace ? 'chat-shell' : ''}`}>
    {screen === 'chat' && agent && workspace ? <>
      <header className="chat-header"><button className="icon-button" aria-label="Back to workspace" onClick={() => setScreen('workspace')}><ArrowLeft size={20} /></button><Avatar name={agent.name} /><div className="header-title"><strong>{agent.name}</strong><Status status={connected ? agent.status : 'offline'} /></div><button className="icon-button" aria-label="Refresh conversation" onClick={() => void api.messages(agent.id).then(setMessages).catch(() => setDeliveryError('Could not refresh this conversation.'))}><RefreshCw size={18} /></button></header>
      <div className="chat-context"><FolderOpen size={14} /><span>{workspace.name}</span><ChevronRight size={13} /><span>{agent.runtime}</span></div>
      <section className="chat-scroll" aria-label="Conversation"><div className="conversation-intro"><div className="intro-icon"><img src={atrisLogo} alt="" /></div><strong>You're connected to {agent.name}</strong><p>Pick up right where you left off on your desktop.</p></div><div className="timeline-label"><span />CONVERSATION<span /></div>
        {messages.map(message => <article className={`message message-${message.role}`} key={message.id}>{message.role !== 'user' && <Avatar name={agent.name} />}<div className="message-content"><div className="message-meta"><strong>{message.role === 'user' ? 'You' : message.role === 'tool' ? 'Activity' : agent.name}</strong>{message.time && <time>{message.time}</time>}</div><div className="message-text">{message.text}</div></div></article>)}<div ref={endRef} /></section>
      <div className="composer-wrap">{deliveryError && <div role="alert" className="inline-error"><CircleAlert size={15} />{deliveryError}</div>}<div className="composer"><textarea aria-label={`Message ${agent.name}`} placeholder={connected ? 'Send a message…' : 'Desktop is offline'} value={draft} maxLength={32000} onChange={event => setDrafts(current => ({ ...current, [agent.id]: event.target.value }))} /><div className="composer-actions"><button className="model-button" onClick={() => void openModels()} disabled={!connected}><span className="model-dot" /> <span>{agent.model}</span>{agent.reasoning && <small>· {agent.reasoning}</small>}<ChevronDown size={14} /></button><div className="composer-right"><button className="icon-button muted-button" aria-label="More options" title="More options will be available when the desktop bridge supports them" disabled><MoreHorizontal size={20} /></button><button className="send-button" aria-label="Send message" disabled={!draft.trim() || sending || !connected || agent.status === 'offline'} onClick={() => void send()}>{sending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={20} />}</button></div></div></div><p className="composer-hint"><Shield size={11} /> Your work stays on your desktop</p></div>
    </> : <>
      <header className="topbar"><div className="brand"><Brand /><span>Atris<span>Agent</span></span></div><button className="desktop-pill" onClick={() => void refresh(true)} aria-label="Refresh desktop connection"><i className={connected ? 'online' : ''} />{connected ? 'Connected' : 'Offline'}<RefreshCw size={13} /></button></header>
      {loading ? <div className="center-state"><LoaderCircle className="spin" /><p>Connecting to your desktop…</p></div> : !connected ? <div className="offline-state"><div className="offline-graphic"><Monitor size={30} /><span><WifiOff size={18} /></span></div><span className="eyebrow">YOUR WORKSPACE, WHEREVER YOU ARE</span><h1>Stay close to<br />your work.</h1><p>Connect to your desktop to follow agents, continue conversations, and keep work moving.</p><div className="offline-notice"><CircleAlert size={18} /><div><strong>Desktop not connected</strong><p>{error || 'Open AtrisAgent on your computer to get started.'}</p></div></div><button className="primary-button" onClick={() => void refresh(true)}><RefreshCw size={17} /> Try again</button><p className="offline-caption">Secure mobile pairing is not available yet.</p></div> : screen === 'home' ? <section className="page"><div className="page-heading"><div><span className="eyebrow">YOUR DESKTOP, IN YOUR POCKET</span><h1>Good to see you<span className="accent">.</span></h1><p>Here's what's happening in your workspaces.</p></div></div><div className="connection-card"><span className="connection-icon"><Monitor size={20} /></span><div><strong>{session?.desktopName || 'Your desktop'}</strong><p><i /> Connected and ready</p></div><ChevronRight size={17} /></div><div className="section-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>Workspaces <span>{workspaces.length}</span></h2></div><button className="icon-button" aria-label="Refresh workspaces" onClick={() => void refresh()}><RefreshCw size={17} /></button></div><label className="search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a workspace" aria-label="Find a workspace" /></label><div className="workspace-list">{workspaces.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map((item, index) => <button className="workspace-card" key={item.id} onClick={() => { setWorkspaceId(item.id); setScreen('workspace'); }}><span className={`workspace-icon workspace-color-${index % 3}`}><FolderOpen size={20} /></span><span className="workspace-info"><strong>{item.name}</strong><small>{item.agents.length} {item.agents.length === 1 ? 'agent' : 'agents'} · {item.agents.filter(value => value.status === 'working').length} active</small></span><ChevronRight size={18} /></button>)}{workspaces.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).length === 0 && <div className="empty-state"><FolderOpen size={22} /><p>{query ? 'No matching workspaces.' : 'No workspaces yet.'}</p></div>}</div><div className="footnote"><Sparkles size={15} /><span>Your agents continue working on your desktop, even when you close this app.</span></div></section> : <section className="page workspace-page"><button className="back-link" onClick={() => setScreen('home')}><ArrowLeft size={16} /> All workspaces</button><div className="workspace-hero"><span className="workspace-icon hero-icon"><FolderOpen size={24} /></span><div><span className="eyebrow">WORKSPACE</span><h1>{workspace?.name}</h1><p>Keep up with your agents and their work.</p></div></div><div className="section-heading"><div><span className="eyebrow">YOUR TEAM</span><h2>Agents <span>{workspace?.agents.length || 0}</span></h2></div><span className="subtle-label">{workspace?.agents.filter(item => item.status === 'working').length || 0} active</span></div><div className="agent-list">{workspace?.agents.map(item => <button className="agent-card" key={item.id} onClick={() => openAgent(item)}><div className="agent-card-top"><Avatar name={item.name} large /><div className="agent-title"><strong>{item.name}</strong><span>{item.runtime} · {item.model}</span></div><ChevronRight size={18} /></div><p>{item.summary || 'Open this conversation to see the latest activity.'}</p><div className="agent-card-bottom"><Status status={item.status} /><span><Clock3 size={13} /> Open conversation</span></div></button>)}{!workspace?.agents.length && <div className="empty-state"><Bot size={24} /><p>No agents in this workspace yet.</p></div>}</div></section>}
      <nav className="bottom-nav" aria-label="Main navigation"><button className="nav-active" onClick={() => setScreen('home')}><Layers3 size={20} /><span>Workspaces</span></button><button disabled title="Coming later"><Clock3 size={20} /><span>Activity</span></button><button disabled title="Coming later"><Plus size={20} /><span>Connect</span></button></nav>
    </>}
    {modelsOpen && agent && <div className="sheet-overlay" onClick={() => setModelsOpen(false)}><section className="sheet" role="dialog" aria-modal="true" aria-labelledby="model-title" onClick={event => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-heading"><div><span className="eyebrow">SESSION SETTINGS</span><h2 id="model-title">Model & reasoning</h2></div><button className="icon-button" aria-label="Close model settings" onClick={() => setModelsOpen(false)}><X size={20} /></button></div><p>Choose from models available on your desktop.</p>{modelError && <p role="alert" className="sheet-error">{modelError}</p>}<div className="model-list">{models.map(model => <div className="model-item" key={model.id}><button disabled={!model.available || modelBusy} onClick={() => void selectModel(model, model.reasoning[0])}><span className="model-icon"><Sparkles size={16} /></span><span><strong>{model.name}</strong><small>{model.runtime}{!model.available && ' · Unavailable'}</small></span>{model.name === agent.model && <Check size={17} />}</button>{model.name === agent.model && model.reasoning.length > 0 && <div className="reasoning"><span>REASONING</span><div>{model.reasoning.map(level => <button key={level} disabled={modelBusy} className={agent.reasoning === level ? 'selected' : ''} onClick={() => void selectModel(model, level)}>{level}</button>)}</div></div>}</div>)}{!models.length && !modelError && <div className="empty-state"><LoaderCircle className="spin" size={20} /><p>Loading models…</p></div>}</div></section></div>}
  </main>;
}

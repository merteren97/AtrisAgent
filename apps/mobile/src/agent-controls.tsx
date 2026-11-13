import { useEffect, useState } from 'react';
import { api, type AgentControls as Controls, type Question } from './api';

function QuestionForm({ agentId, question, done }: { agentId: string; question: Question; done(): void }) {
  const [answers, setAnswers] = useState<string[][]>(question.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(question.questions.map(() => ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="question-form" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('');
    void api.replyQuestion(agentId, question.id, answers.map((selected, index) => [...selected, ...(custom[index].trim() ? [custom[index].trim()] : [])])).then(done).catch(cause => setError(cause.message)).finally(() => setBusy(false));
  }}>{question.questions.map((item, index) => <fieldset key={index} disabled={busy}><legend>{item.question}</legend>{item.options.map(option => <label key={option.label}><input type={item.multiple ? 'checkbox' : 'radio'} name={`question-${question.id}-${index}`} checked={answers[index].includes(option.label)} onChange={event => setAnswers(previous => previous.map((value, i) => i !== index ? value : item.multiple ? event.target.checked ? [...value, option.label] : value.filter(label => label !== option.label) : [option.label]))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}{item.custom && <label>Your answer<input value={custom[index]} onChange={event => setCustom(values => values.map((value, i) => i === index ? event.target.value : value))} maxLength={4000} /></label>}</fieldset>)}{error && <p role="alert" className="sheet-error">{error}</p>}<button className="primary-button" disabled={busy || answers.some((selected, index) => !selected.length && !custom[index].trim())}>{busy ? 'Sending answer…' : 'Reply to agent'}</button></form>;
}

export function AgentControls({ agentId }: { agentId: string }) {
  const [controls, setControls] = useState<Controls>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const load = () => api.controls(agentId).then(setControls).catch(cause => setError(cause.message));
  useEffect(() => { let active = true; const refresh = () => { void api.controls(agentId).then(value => { if (active) setControls(value); }).catch(cause => { if (active) setError(cause.message); }); }; refresh(); const timer = setInterval(refresh, 3000); return () => { active = false; clearInterval(timer); }; }, [agentId]);
  const apply = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); setNotice('Request sent. The state below reflects the desktop confirmation.'); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not apply the change.'); } finally { setBusy(false); } };
  return <div className="remote-controls">{error && <p role="alert" className="sheet-error">{error}</p>}{notice && <p role="status" className="account-note">{notice}</p>}{!controls && !error && <p>Loading desktop controls…</p>}
    {!!controls?.questions.length && <section><h3>Agent needs your answer</h3>{controls.questions.map(question => <QuestionForm key={question.id} agentId={agentId} question={question} done={() => { void load(); }} />)}</section>}
    {controls?.autoApprove && <section><h3>OpenCode permissions</h3><p>Current: {controls.autoApprove.enabled ? 'Auto-approve enabled' : 'Ask for permissions'}. Explicit deny rules still apply.</p><button className="account-secondary" disabled={busy || !controls.autoApprove.available} onClick={() => void apply(() => api.autoApprove(agentId, !controls.autoApprove!.enabled, controls.autoApprove!.enabled))}>{controls.autoApprove.enabled ? 'Disable auto-approve' : 'Enable auto-approve'}</button></section>}
    {controls?.permissions && <section><h3>Codex permissions</h3><p>Current: {controls.permissions.mode || 'Not verified'}{!controls.permissions.available && ` · ${controls.permissions.reason || 'Live session not ready'}`}</p><label>Permission mode<select aria-label="Permission mode" value={mode || controls.permissions.mode || 'ask-for-approval'} onChange={event => { setMode(event.target.value); setConfirmed(false); }}><option value="ask-for-approval">Ask for approval</option><option value="approve-for-me">Approve for me</option><option value="read-only">Read only</option><option value="full-access">Full access</option></select></label>{mode === 'full-access' && <label className="permission-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Allow this agent filesystem and network access without ordinary approval prompts.</label>}<button className="account-secondary" disabled={busy || !mode || !controls.permissions.available || controls.permissions.applying || (mode === 'full-access' && !confirmed)} onClick={() => void apply(() => api.permissions(agentId, mode, controls, confirmed))}>Apply permission mode</button></section>}
    {controls && <section><h3>Memory & references</h3>{controls.memory.unavailable ? <p>Conversation memory is unavailable on the desktop.</p> : controls.memory.nodes.length ? controls.memory.nodes.map(node => <article className="memory-note" key={node.id}><strong>{node.title}</strong><p>{node.summary}</p></article>) : <p>No saved memory for this agent.</p>}</section>}
  </div>;
}

/** Runs in the TUI, not its server worker: HTTP command success is not UI confirmation. */
export const MANUAL_OPENCODE_TUI = '// AtrisAgent managed manual session bridge v1\n' + String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const id = 'atris-manual-controls';
export const tui = async (api, options) => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const modeFile = path.join(root, 'opencode-auto-mode.json');
  const requestFile = path.join(root, 'opencode-auto-request.json');
  const routeFile = path.join(root, 'opencode-route.json');
  const routeStateFile = path.join(root, 'opencode-route-state.json');
  const modelFile = path.join(api.state.path.state, 'model.json');
  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
  const save = (file, value) => { fs.writeFileSync(file+'.tmp', JSON.stringify(value), {mode:0o600}); fs.renameSync(file+'.tmp', file); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const commands = () => api.keymap.getCommandEntries({visibility:'registered',namespace:'palette'}).map(entry => entry.command);
  const mode = () => {
    const title = commands().find(command => command.name === 'permission.mode')?.title;
    if (title === 'Disable auto-approve permissions') return true;
    if (title === 'Enable auto-approve permissions') return false;
    return undefined;
  };
  let busy = false, disposed = false, modeError, appliedRoute, pendingRoute;
  // A route remount restores the actual saved user message, never a fabricated prompt.
  const unregister = api.route.register([{name:'atris-route-sync',render:() => null}]);
  const variants = () => read(modelFile)?.variant || {};
  const launchModel = options?.model || read(routeFile)?.model;
  const cycle = async () => {
    const before = variants();
    await api.keymap.dispatchCommand('variant.cycle');
    for (let attempt = 0; attempt < 30 && !disposed; attempt++) {
      await sleep(20);
      const after = variants();
      const key = Object.keys(after).find(key => after[key] !== before[key]);
      if (key) return {key, value:after[key], previous:before[key] || 'default'};
    }
    throw new Error('OpenCode did not confirm its reasoning selection.');
  };
  const selectVariant = async (route) => {
    const slash = route.model.indexOf('/');
    const model = api.state.provider.find(provider => provider.id === route.model.slice(0,slash))?.models[route.model.slice(slash+1)];
    const list = Object.keys(model?.variants || {});
    const desired = route.reasoning || 'default';
    if (!list.length) {
      if (route.reasoning) throw new Error('This CLI model has no reasoning variants.');
      return true;
    }
    if (desired !== 'default' && !list.includes(desired)) throw new Error('The CLI does not support this reasoning variant.');
    // Public TUI commands mutate the real selection. The process-private state file
    // confirms which model is active and what the command actually selected.
    let selected = await cycle();
    if (selected.key !== route.model) {
      const currentSlash = selected.key.indexOf('/');
      const current = api.state.provider.find(provider => provider.id === selected.key.slice(0,currentSlash))?.models[selected.key.slice(currentSlash+1)];
      const limit = Object.keys(current?.variants || {}).length + 1;
      for (let i = 0; selected.value !== selected.previous && i < limit; i++) {
        const previous = selected.previous;
        selected = {...await cycle(), previous};
      }
      return false;
    }
    for (let i = 0; selected.value !== desired && i < list.length + 1; i++) selected = await cycle();
    if (selected.key !== route.model || selected.value !== desired) throw new Error('OpenCode did not apply the selected reasoning.');
    return true;
  };
  const tick = async () => {
    if (busy || disposed || !api.state.ready) return;
    busy = true;
    try {
      let enabled = mode();
      const request = read(requestFile);
      if (enabled !== undefined && typeof request?.enabled === 'boolean') {
        if (enabled !== request.enabled && api.ui.dialog.open) {
          if (typeof request.at === 'number' && Date.now()-request.at > 4500) {
            modeError = 'Close the dialog in Code and retry the Auto mode change.';
            fs.rmSync(requestFile,{force:true});
          }
          save(modeFile, {version:4,enabled,at:Date.now(),...(modeError ? {error:modeError} : {})});
          return;
        }
        try {
          if (enabled !== request.enabled) await api.keymap.dispatchCommand('permission.mode');
          enabled = mode();
          if (enabled !== request.enabled) throw new Error('OpenCode did not confirm the Auto mode change.');
          modeError = undefined;
        } catch { modeError = 'Could not change OpenCode Auto mode. Retry or use Code.'; }
        fs.rmSync(requestFile, {force:true});
      }
      if (enabled !== undefined) save(modeFile, {version:4,enabled,at:Date.now(),...(modeError ? {error:modeError} : {})});
      const route = read(routeFile);
      if (!route?.id) return;
      const current = api.route.current;
      const sessionID = current.name === 'session' ? current.params.sessionID : undefined;
      const boundSession = read(path.join(root,'opencode-history.json'))?.sessionId;
      if (boundSession && sessionID !== boundSession) return;
      if (sessionID && api.state.session.get(sessionID)?.parentID) return;
      if (route.id === appliedRoute) {
        if ((variants()[route.model] || 'default') === (route.reasoning || 'default')) return;
        // A native session remount restores its last message's old variant.
        // Reconcile that change too; a prior receipt is not a perpetual guarantee.
        appliedRoute = undefined;
        pendingRoute = undefined;
        save(routeStateFile, {id:route.id,applied:false});
      }
      if (api.ui.dialog.open) return;
      if (sessionID && api.state.session.status(sessionID)?.type === 'busy') return;
      const last = sessionID && api.state.session.messages(sessionID).filter(message => message.role === 'user').at(-1);
      const pendingKey = route.id+':'+(last?.id || '');
      if (pendingRoute === pendingKey) return;
      const lastModel = last?.model && last.model.providerID+'/'+last.model.modelID;
      if ((lastModel && lastModel !== route.model) || (!lastModel && launchModel !== route.model)) {
        pendingRoute = pendingKey;
        save(routeStateFile, {id:route.id,applied:false});
        return;
      }
      try {
        if (lastModel === route.model && (last.model.variant || 'default') === (route.reasoning || 'default') && (pendingRoute || lastModel !== launchModel)) {
          api.route.navigate('atris-route-sync');
          await sleep(40);
          if (disposed) return;
          api.route.navigate('session', {sessionID});
          await sleep(120);
        }
        let selected = await selectVariant(route);
        if (!selected && last?.model?.providerID+'/'+last?.model?.modelID === route.model && (last.model.variant || 'default') === (route.reasoning || 'default')) {
          api.route.navigate('atris-route-sync');
          await sleep(40);
          if (disposed) return;
          api.route.navigate('session', {sessionID});
          await sleep(120);
          selected = await selectVariant(route);
        }
        if (!selected) {
          pendingRoute = pendingKey;
          save(routeStateFile, {id:route.id,applied:false});
          return;
        }
        appliedRoute = route.id;
        save(routeStateFile, {id:route.id,applied:true});
      } catch (error) {
        pendingRoute = pendingKey;
        save(routeStateFile, {id:route.id,applied:false,error:error.message});
      }
    } catch { /* An observer must never terminate the user's CLI. */ }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 250);
  timer.unref?.();
  api.lifecycle.onDispose(() => { disposed = true; clearInterval(timer); unregister(); fs.rmSync(modeFile,{force:true}); });
};
export default {id,tui};
`;

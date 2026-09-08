const assert = require('node:assert/strict');
const {chromium}=require('C:/Users/merte/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const setup = async page => {
const moduleFiles=['/src/components/inspector/inspector-panel.tsx','/src/components/layout/sidebar.tsx','/src/components/layout/titlebar.tsx','/src/components/layout/workspace-home.tsx','/src/components/manual/manual-workspace.tsx'];
const stores=new Set();
for(const file of moduleFiles){const source=await(await page.request.get('http://127.0.0.1:1420'+file)).text();for(const m of source.matchAll(/from "(\/src\/stores\/[^"]+)"/g))stores.add(m[1]);}
await page.reload();
await page.evaluate(async paths=>{
 await import('/src/styles/globals.css');
 const React=(await import('/node_modules/.vite/deps/react.js')).default;const h=React.createElement;
 const client=await import('/node_modules/.vite/deps/react-dom_client.js');
 const {AppShell}=await import('/src/components/layout/app-shell.tsx');const {Sidebar}=await import('/src/components/layout/sidebar.tsx');const {Titlebar}=await import('/src/components/layout/titlebar.tsx');
 const {ConversationChoice}=await import('/src/components/layout/workspace-home.tsx');const {ManualWorkspace}=await import('/src/components/manual/manual-workspace.tsx');
 const {InspectorPanel}=await import('/src/components/inspector/inspector-panel.tsx');
 const {ChatTimeline}=await import('/src/components/chat/chat-timeline.tsx');const {ChatComposer}=await import('/src/components/composer/chat-composer.tsx');
 const {ThemeProvider}=await import('/src/components/theme-provider.tsx');const {TooltipProvider}=await import('/src/components/ui/tooltip.tsx');const {AuthSessionProvider}=await import('/src/lib/auth-session.tsx');
 const modules={};for(const p of paths)Object.assign(modules,await import(p));
 const {useWorkspaceStore:w,useManualStore:m,useMissionStore:ms,useSettingsStore:ss,useAccountStore:as}=modules;
 const project={id:'review-project',name:'AtrisAgent',path:'D:/Projects/AtrisAgent'};
 const conv={id:'review-conversation',workspaceId:project.id,title:'Desktop workspace redesign',createdAt:'2026-09-08T13:00:00Z',agents:[{id:'review-agent',conversationId:'review-conversation',name:'Interface designer',runtimeType:'claude_code',model:'Claude Sonnet',cwd:project.path},{id:'review-agent-2',conversationId:'review-conversation',name:'Code reviewer',runtimeType:'codex',model:'GPT-5',cwd:project.path}]};
 w.setState({activeWorkspaceId:project.id,workspaces:[project,{id:'review-project-2',name:'Design system',path:'D:/Projects/Design'}],fetchWorkspaces:async()=>{}});
 ms.setState({missions:[{id:'review-mission',workspaceId:project.id,title:'Review authentication flow',status:'completed',createdAt:'2026-09-08T12:00:00Z'}],fetchMissions:async()=>{},fetchMissionState:async()=>{},activeMissionId:null});
 m.setState({mode:'choose',conversations:{[project.id]:[conv]},activeByWorkspace:{[project.id]:conv.id},refresh:async()=>{}});
 ss.setState({activeView:'chat',sidebarCollapsed:false,sidebarWidth:256,devMode:false,inspectorCollapsed:true});
 as.setState({discoveredModels:[{id:'review-model',catalogId:'review-model',runtimeModelId:'claude-sonnet',provider:'anthropic',runtimeType:'claude_code',name:'Claude Sonnet',available:true,availability:'available',accountName:'CLI account',accountProfileId:'review-account',supportsReasoning:false,supportedReasoning:[],routeLabel:'CLI',contextClass:'standard',speedClass:'standard',entitlement:'account',quotaInfo:'unknown',statusBadge:'Connected',suitableRoles:[],category:'connected',source:'runtime'}]});
 window.fetch=async input=>new Response(JSON.stringify(String(input).includes('/manual/conversations')?[conv]:String(input).includes('/workspaces')?[project]:String(input).includes('/messages')?{bound:true,truncated:false,messages:[{id:'u1',role:'user',text:'Let’s simplify the workspace and make agent controls easier to find.'},{id:'a1',role:'assistant',text:'I’ll organize the workspace around your conversation.\n\n### What will change\n- A clear place to start Manual or Orchestrator work.\n- Independent agent sessions with readable status.\n- Chat and Code views that preserve the same context.'}]}:[]),{status:200,headers:{'content-type':'application/json'}});
 function Preview(){const mode=m(s=>s.mode);const view=ss(s=>s.activeView);return h(AppShell,{sidebar:h(Sidebar),inspector:mode==='orchestrator'?h(InspectorPanel):null,main:h('main',{className:'flex min-h-0 min-w-0 flex-1 flex-col'},h(Titlebar),view==='chat'?(mode==='manual'?h(ManualWorkspace):mode==='choose'?h(ConversationChoice):h(React.Fragment,null,h(ChatTimeline),h(ChatComposer))):h('div',{className:'p-8'},view))});}
 window.review={h,Preview,ThemeProvider,TooltipProvider,AuthSessionProvider,modules};
 window.reviewRoot=(client.default||client).createRoot(document.getElementById('root'));
 window.reviewRoot.render(h(ThemeProvider,{attribute:'class',forcedTheme:'dark'},h(TooltipProvider,null,h(AuthSessionProvider,null,h(Preview)))));
},[...stores]);
await page.getByRole('heading',{name:'Start working',exact:true}).waitFor();
return {visible:true,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)};
};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[]; page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/workspace-design-review',route=>route.fulfill({contentType:'text/html',body:`<html><head></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>`}));
 await page.goto('http://127.0.0.1:1420/workspace-design-review');
 await setup(page);
 await page.evaluate(()=>{window.review.modules.useManualStore.setState({mode:'manual',creating:true});});
 await page.getByRole('heading',{name:'Choose your AI. Make it your workspace.'}).waitFor();
 assert.equal(await page.getByRole('dialog').count(),0,'Manual setup is not a popup');
 await page.getByRole('radio',{name:/Antigravity/}).check();
 await page.getByText(/Antigravity opens in Code/).waitFor();
 await page.getByText('4 panes',{exact:true}).click();
 assert.equal(await page.getByRole('radio',{name:'4 panes',exact:true}).isChecked(),true);
 await page.getByLabel('Conversation name').fill('Interface improvements');
 assert.equal(await page.getByRole('button',{name:'Create conversation',exact:true}).isDisabled(),true,'Unavailable providers cannot create agents');
 await page.getByRole('radio',{name:/Claude Code/}).check();
 let primaryBounds=await page.getByRole('button',{name:'Create conversation',exact:true}).boundingBox();
 assert.ok(primaryBounds.y+primaryBounds.height<=1000,'Creation action remains visible');
 await page.screenshot({path:'.playwright-mcp/manual-setup-dark.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.evaluate(()=>{
   const fallback=window.fetch;let created;
   window.fetch=async(input,init)=>{
     const url=String(input);const body=init?.body?JSON.parse(init.body):{};
     if(init?.method==='POST' && url.endsWith('/manual/conversations')) {
       created={...body,createdAt:new Date().toISOString(),agents:[]};return new Response(JSON.stringify(created),{status:200,headers:{'Content-Type':'application/json'}});
     }
     if(init?.method==='POST' && /manual\/conversations\/[^/]+\/agents$/.test(url)) return new Response(JSON.stringify({...body,conversationId:created.id,runtimeType:'claude_code',model:'Claude Sonnet',cwd:'D:/Projects/AtrisAgent'}),{status:200,headers:{'Content-Type':'application/json'}});
     return fallback(input,init);
   };
 });
 await page.getByRole('button',{name:'Create conversation',exact:true}).click();
 await page.getByRole('region',{name:'Manual conversation'}).waitFor({timeout:5000}).catch(async error=>{console.log(JSON.stringify(await page.evaluate(()=>({mode:window.review.modules.useManualStore.getState().mode,creating:window.review.modules.useManualStore.getState().creating,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)}))));throw error;});
 assert.equal(await page.evaluate(()=>{const state=window.review.modules.useManualStore.getState();return state.layoutByConversation[state.activeByWorkspace['review-project']];}),4,'Creation persists the chosen layout');
 assert.equal(await page.evaluate(()=>window.review.modules.useManualStore.getState().mode),'manual','Successful creation opens the conversation');
 await page.evaluate(()=>window.review.modules.useManualStore.setState({creating:true}));
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('heading',{name:'Start working',exact:true}).waitFor();
 await page.evaluate(()=>{window.review.modules.useManualStore.setState({mode:'orchestrator'});});
 await page.getByRole('button',{name:'Open Mission Workbench',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Mission Workbench'});
 await dialog.waitFor();
 let bounds=await dialog.boundingBox();
 assert.equal(bounds.x,24); assert.equal(bounds.width,1392);
 await page.evaluate(()=>window.review.modules.useMissionStore.setState({activeMissionId:'review-mission',activeTasks:[
 {id:'task-1',missionId:'review-mission',title:'Review the existing authentication boundary',description:'Confirm provider discovery and preserve the current account session.',status:'completed',assignedRole:'Researcher',dependencies:[]},
 {id:'task-2',missionId:'review-mission',title:'Refine workspace navigation',description:'Bring independent agents and orchestrated work into a consistent experience.',status:'running',assignedRole:'Builder',dependencies:['task-1']},
 {id:'task-3',missionId:'review-mission',title:'Verify keyboard and window-size behavior',description:'Review the actual rendered workspace and its recovery states.',status:'pending',assignedRole:'QA',dependencies:['task-2']}
 ]}));
 await page.getByRole('heading',{name:'Refine workspace navigation'}).waitFor();
 await page.screenshot({path:'.playwright-mcp/workbench-plan.png'});
 await page.getByRole('button',{name:'Team Agents and live activity'}).click();
 await page.getByRole('tab',{name:'Activity',exact:true}).click();
 for(let i=0;i<12;i++) await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.getElementById('mission-workbench').contains(document.activeElement)),true,'Modal focus remains contained');
 await page.screenshot({path:'.playwright-mcp/workbench-dark.png'});
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Design system',exact:true}).click();
 await page.getByRole('heading',{name:'Start working',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.review.modules.useWorkspaceStore.getState().activeWorkspaceId),'review-project-2');
 await page.evaluate(()=>window.review.modules.useManualStore.setState({mode:'orchestrator'}));
 await page.getByRole('button',{name:'Design system',exact:true}).click();
 await page.getByRole('heading',{name:'Start working',exact:true}).waitFor();
 await page.evaluate(()=>window.review.modules.useManualStore.setState({mode:'orchestrator'}));
 assert.equal(await dialog.count(),0);
 await page.getByRole('button',{name:'Open Mission Workbench'}).click();
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Open Mission Workbench');
 await page.getByRole('button',{name:'Open Mission Workbench'}).click();
 await page.setViewportSize({width:900,height:760});
 bounds=await dialog.boundingBox(); assert.equal(bounds.x,20); assert.equal(bounds.width,860);
 await page.screenshot({path:'.playwright-mcp/workbench-compact.png'});
 await page.keyboard.press('Escape');
 await page.evaluate(()=>{const r=window.review; r.reviewTheme='light';window.reviewRoot.render(r.h(r.ThemeProvider,{attribute:'class',forcedTheme:'light'},r.h(r.TooltipProvider,null,r.h(r.AuthSessionProvider,null,r.h(r.Preview)))));r.modules.useManualStore.setState({mode:'manual',creating:true});});
 await page.getByRole('heading',{name:'Choose your AI. Make it your workspace.'}).waitFor();
 primaryBounds=await page.getByRole('button',{name:'Create conversation',exact:true}).boundingBox();
 assert.ok(primaryBounds.y+primaryBounds.height<=760,'Creation remains visible in a compact window');
 await page.screenshot({path:'.playwright-mcp/manual-setup-light-compact.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.evaluate(()=>window.review.modules.useManualStore.setState({mode:'orchestrator'}));
 await page.getByRole('button',{name:'Open Mission Workbench'}).click();
 await page.screenshot({path:'.playwright-mcp/workbench-light-compact.png'});
 console.log(JSON.stringify({passed:true,errors,screenshots:6}));
 assert.deepEqual(errors,[]);
 } finally {await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});

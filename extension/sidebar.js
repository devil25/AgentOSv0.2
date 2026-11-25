const api=globalThis.browser;
const $=id=>document.getElementById(id);
let stopped=false;
function out(value){$('output').textContent=typeof value==='string'?value:JSON.stringify(value,null,2)}
function logState(s){$('taskState').textContent=s.toUpperCase()}
async function native(payload){return api.runtime.sendMessage({type:'AGENTOS_NATIVE_REQUEST',payload});}
function setRuntime(ok,msg){$('runtimeText').textContent=msg;$('runtimeBadge').textContent=ok?'CONNECTED':'OFFLINE';$('runtimeBadge').className='badge '+(ok?'good':'bad');$('runtimeLed').classList.toggle('online',ok)}
async function testRuntime(){setRuntime(false,'Connecting…');const r=await native({type:'runtime.status'});setRuntime(!!r?.ok,r?.ok?'Windows runtime online':(r?.error||'Runtime unavailable'));out(r)}
async function runAction(){
  let cmd;try{cmd=JSON.parse($('commandInput').value)}catch(e){out('Invalid JSON: '+e.message);return}
  if(cmd.protocol!=='agentos.v1'||cmd.type!=='action'||typeof cmd.action!=='string'){out('Invalid AgentOS action envelope.');return}
  logState('running');$('runBtn').disabled=true;
  try{
    let result;
    if(cmd.action==='browser.open_url') result=await api.runtime.sendMessage({type:'AGENTOS_OPEN_URL',url:cmd.arguments?.url});
    else result=await native({type:'action.execute',action:cmd.action,arguments:cmd.arguments||{}});
    out(result);logState(result?.ok?'completed':'failed');
  }catch(e){out(String(e));logState('error')}
  finally{$('runBtn').disabled=false}
}
async function capture(){const r=await api.runtime.sendMessage({type:'AGENTOS_PAGE_INFO'});if(!r?.ok){out(r);return}$('pageTitle').textContent=r.title||'Untitled';$('pageUrl').textContent=r.url||'';out({title:r.title,url:r.url,text:(r.text||'').slice(0,8000)});}
async function list(kind,target){const r=await native({type:kind+'.list'});target.replaceChildren();if(!r?.ok){target.textContent=r?.error||'Runtime unavailable';return}const items=r.items||[];if(!items.length){target.textContent='No items installed.';return}for(const item of items){const el=document.createElement('div');el.className='list-item';const b=document.createElement('b');b.textContent=item.name||item.id||'Unnamed';const s=document.createElement('small');s.textContent=item.description||item.status||'Installed';el.append(b,s);target.append(el)}}
$('connectBtn').addEventListener('click',testRuntime);
$('runBtn').addEventListener('click',runAction);
$('captureBtn').addEventListener('click',capture);
$('stopBtn').addEventListener('click',async()=>{stopped=!stopped;const r=await api.runtime.sendMessage({type:'AGENTOS_SET_STOP',value:stopped});$('stopBtn').textContent=stopped?'Resume':'Stop';out(stopped?'AgentOS stopped for new actions.':'AgentOS resumed.');logState(stopped?'stopped':'idle')});
$('skillsRefresh').addEventListener('click',()=>list('skills',$('skillsList')));
$('pluginsRefresh').addEventListener('click',()=>list('plugins',$('pluginsList')));
$('mcpRefresh').addEventListener('click',()=>list('mcp',$('mcpList')));
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab,.panel').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('panel-'+b.dataset.tab).classList.add('active')}));
testRuntime();

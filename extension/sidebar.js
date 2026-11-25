const api=globalThis.browser;
const $=id=>document.getElementById(id);
let stopped=false;
function out(value){$("output").textContent=typeof value==="string"?value:JSON.stringify(value,null,2)}
function logState(s){$("taskState").textContent=s.toUpperCase()}
async function native(payload){return api.runtime.sendMessage({type:"AGENTOS_NATIVE_REQUEST",payload});}
function setRuntime(ok,msg){$("runtimeText").textContent=msg;$("runtimeBadge").textContent=ok?"CONNECTED":"OFFLINE";$("runtimeBadge").className="badge "+(ok?"good":"bad");$("runtimeLed").classList.toggle("online",ok)}
async function testRuntime(){setRuntime(false,"Connecting…");const r=await native({type:"runtime.status"});setRuntime(!!r?.ok,r?.ok?"Windows runtime online":(r?.error||"Runtime unavailable"));out(r)}
async function providerCheck(){
  const r=await api.runtime.sendMessage({type:"AGENTOS_PROVIDER_INSPECT"});
  $("providerText").textContent=r?.ok?("Detected: "+r.providerName+" · composer "+(r.composerAvailable?"ready":"not found")):(r?.error||"No supported AI website detected");
  out(r);
}
const AGENTOS_INSTRUCTIONS = [
  "You are the planning assistant for AgentOS, a supervised browser agent.",
  "The user is asking you to help perform a task through the browser UI, not through APIs.",
  "Do not claim an action was executed unless the user provides its execution result.",
  "For now, return one safe, concrete next action only, using this exact JSON envelope when a supported action is appropriate:",
  '{"protocol":"agentos.v1","type":"action","action":"ACTION_NAME","arguments":{}}',
  "Supported actions: runtime.status, skills.list, plugins.list, mcp.list, mcp.tools, mcp.call, skills.read, plugins.call, workspace.list, workspace.read_file, workspace.create_file.",
  "Do not propose terminal commands, arbitrary code execution, deleting files, sending messages, publishing, purchases, or external side effects.",
  "If the task needs multiple steps or an unsupported action, explain the limitation and ask the user before proceeding.",
  "Put the JSON action in a fenced json code block and explain its purpose briefly."
].join("\n");
async function sendTask(){
  const task=$("taskInput").value.trim();
  if(!task){out("Write a task first.");return}
  if(stopped){out("AgentOS is stopped. Resume it first.");return}
  const info=await api.runtime.sendMessage({type:"AGENTOS_PROVIDER_INSPECT"});
  if(!info?.ok||!info.composerAvailable){out(info?.error||"Open a supported AI website and make sure its message box is available.");return}
  const prompt=AGENTOS_INSTRUCTIONS+"\n\nUSER TASK:\n"+task;
  logState("sending");
  const fill=await api.runtime.sendMessage({type:"AGENTOS_PROVIDER_FILL",prompt});
  if(!fill?.ok){out(fill);logState("failed");return}
  const confirmed=confirm("AgentOS filled the task into "+info.providerName+". Submit it to that website now?");
  if(!confirmed){out("Task filled but not submitted. Review it in the AI website before sending.");logState("awaiting approval");return}
  const sent=await api.runtime.sendMessage({type:"AGENTOS_PROVIDER_SUBMIT"});
  out({provider:info.providerName,fill,submit:sent});
  logState(sent?.ok?"submitted":"failed");
}
async function readResponse(){
  const r=await api.runtime.sendMessage({type:"AGENTOS_PROVIDER_READ"});
  if(!r?.ok){out(r);return}
  const text=(r.messages||[]).join("\n\n---\n\n");
  out(text||"No assistant response was detected yet.");
  if(text){
    const match=text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if(match && confirm("A JSON block was found. Copy it into the action review box?")){
      $("commandInput").value=match[1].trim();
      logState("action ready for review");
    }
  }
}
async function runAction(){
  let cmd;try{cmd=JSON.parse($("commandInput").value)}catch(e){out("Invalid JSON: "+e.message);return}
  if(cmd.protocol!=="agentos.v1"||cmd.type!=="action"||typeof cmd.action!=="string"){out("Invalid AgentOS action envelope.");return}
  if(!confirm("Run this action?\n\n"+cmd.action+"\n\nReview its arguments in the box before continuing."))return;
  logState("running");$("runBtn").disabled=true;
  try{
    let result;
    if(cmd.action==="browser.open_url") result=await api.runtime.sendMessage({type:"AGENTOS_OPEN_URL",url:cmd.arguments?.url});
    else result=await native({type:"action.execute",action:cmd.action,arguments:cmd.arguments||{}});
    out(result);logState(result?.ok?"completed":"failed");
  }catch(e){out(String(e));logState("error")}
  finally{$("runBtn").disabled=false}
}
async function capture(){const r=await api.runtime.sendMessage({type:"AGENTOS_PAGE_INFO"});if(!r?.ok){out(r);return}$("pageTitle").textContent=r.title||"Untitled";$("pageUrl").textContent=r.url||"";out({title:r.title,url:r.url,text:(r.text||"").slice(0,8000)});}
async function list(kind,target){const r=await native({type:kind+".list"});target.replaceChildren();if(!r?.ok){target.textContent=r?.error||"Runtime unavailable";return}const items=r.items||[];if(!items.length){target.textContent="No items installed.";return}for(const item of items){const el=document.createElement("div");el.className="list-item";const b=document.createElement("b");b.textContent=item.name||item.id||"Unnamed";const s=document.createElement("small");s.textContent=item.description||item.status||"Installed";el.append(b,s);target.append(el)}}
$("connectBtn").addEventListener("click",testRuntime);
$("providerCheckBtn").addEventListener("click",providerCheck);
$("sendTaskBtn").addEventListener("click",sendTask);
$("readResponseBtn").addEventListener("click",readResponse);
$("runBtn").addEventListener("click",runAction);
$("captureBtn").addEventListener("click",capture);
$("stopBtn").addEventListener("click",async()=>{stopped=!stopped;const r=await api.runtime.sendMessage({type:"AGENTOS_SET_STOP",value:stopped});$("stopBtn").textContent=stopped?"Resume":"Stop";out(stopped?"AgentOS stopped for new actions.":"AgentOS resumed.");logState(stopped?"stopped":"idle")});
$("skillsRefresh").addEventListener("click",()=>list("skills",$("skillsList")));
$("pluginsRefresh").addEventListener("click",()=>list("plugins",$("pluginsList")));
$("mcpRefresh").addEventListener("click",()=>list("mcp",$("mcpList")));
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab,.panel").forEach(x=>x.classList.remove("active"));b.classList.add("active");$("panel-"+b.dataset.tab).classList.add("active")}));
testRuntime();
providerCheck();

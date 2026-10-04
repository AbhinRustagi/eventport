import { eventport } from '/dist/index.js';
import { chatCompletions, responses } from '/dist/adapters/openai.js';
import { anthropic } from '/dist/adapters/anthropic.js';
import { agUI } from '/dist/adapters/agui.js';
import { aiSDK } from '/dist/adapters/vercel.js';
import { langGraph } from '/dist/adapters/langgraph.js';
import { samples } from '/playground/samples.mjs';
const $ = id => document.getElementById(id);
const factories = { 'chat-completions': chatCompletions, responses, anthropic, agui: () => agUI({threadId:'thread_demo',runId:'run_demo'}), 'ai-sdk': aiSDK, langgraph: langGraph };
const names = { 'chat-completions':'chatCompletions()',responses:'responses()',anthropic:'anthropic()',agui:'agUI({ threadId, runId })','ai-sdk':'aiSDK()',langgraph:'langGraph()' };
let mode = 'stored', running, result = [];
function snippet() { $('code').textContent = `eventport\n  .convert(${mode === 'stored' ? 'storedEvents' : 'upstream'})\n  .from(${names[$('source').value]})\n  .to(${names[$('target').value]})\n  .${mode === 'stored' ? 'collect()' : 'toResponse()'};`; }
function reset() { $('input').value = JSON.stringify(samples[$('source').value], null, 2); count(); snippet(); }
function count() { try { const input=JSON.parse($('input').value); $('input-count').textContent=Array.isArray(input)?`${input.length} events`:'Expected array'; } catch { $('input-count').textContent='Invalid JSON'; } }
function diagnostic(message) { $('diagnostics').hidden=false; $('diagnostics').textContent += `${message}\n`; }
function append(event) {
  const row=document.createElement('details'); row.className='event';
  const title=document.createElement('summary'), number=document.createElement('span'), name=document.createElement('b');
  number.textContent=String(result.length).padStart(2,'0'); name.textContent=event.type??event.object??event.event;
  title.append(number,name); const payload=document.createElement('pre'); payload.textContent=JSON.stringify(event,null,2); row.append(title,payload); $('output').append(row); $('output-count').textContent=`${result.length} events`;
  $('output').scrollTop=$('output').scrollHeight;
}
function middleware(source) {
  if (!$('uppercase').checked) return {};
  if (source==='responses') return {'response.output_text.delta':e=>({...e,delta:e.delta.toUpperCase()})};
  if (source==='agui') return {TEXT_MESSAGE_CONTENT:e=>({...e,delta:e.delta.toUpperCase()})};
  if (source==='ai-sdk') return {'text-delta':e=>({...e,delta:e.delta.toUpperCase()})};
  if (source==='anthropic') return {content_block_delta:e=>e.delta.type==='text_delta'?{...e,delta:{...e.delta,text:e.delta.text.toUpperCase()}}:e};
  if (source==='chat-completions') return {'chat.completion.chunk':e=>({...e,choices:e.choices.map(c=>({...c,delta:{...c.delta,...(typeof c.delta.content==='string'?{content:c.delta.content.toUpperCase()}:{})}}))})};
  return {messages:e=>({...e,data:[{...e.data[0],content:typeof e.data[0].content==='string'?e.data[0].content.toUpperCase():e.data[0].content},e.data[1]]})};
}
$('run').addEventListener('click',async()=>{
  const controller=new AbortController(); running=controller;
  $('diagnostics').hidden=true; $('diagnostics').textContent=''; $('output').replaceChildren(); result=[]; $('output-count').textContent='0 events';
  $('run').disabled=true; $('stop').hidden=false; $('status').textContent='Converting…';
  const start=performance.now();
  try {
    const events=JSON.parse($('input').value); if(!Array.isArray(events)) throw new Error('Input must be a JSON array of native events.');
    async function* replay(){for(const event of events){await new Promise(resolve=>setTimeout(resolve,160));controller.signal.throwIfAborted();yield event;}}
    const source=$('source').value,target=$('target').value;
    const pipeline=eventport.convert(mode==='live'?replay():events,{signal:controller.signal}).from(factories[source](),{middleware:middleware(source)}).to(factories[target]()).onUnsupported(d=>{diagnostic(`${d.adapter} / ${d.stage}: ${d.reason}`);return $('policy').value==='drop'?'drop':'error';});
    for await(const event of pipeline){result.push(event);append(event);}
    $('status').textContent=`${result.length} events · ${Math.round(performance.now()-start)} ms · ${mode==='live'?'live replay':'stored array'}`;
  } catch(error) { $('status').textContent=controller.signal.aborted?'Cancelled':'Conversion failed';diagnostic(error.message??String(error)); }
  finally { $('run').disabled=false; $('stop').hidden=true; running=undefined; }
});
$('stop').addEventListener('click',()=>running?.abort());
$('reset').addEventListener('click',reset);
$('source').addEventListener('change',reset); $('target').addEventListener('change',snippet); $('input').addEventListener('input',count);
for(const option of ['stored','live']) $(option).addEventListener('click',()=>{mode=option;for(const id of ['stored','live']){$(id).classList.toggle('active',id===mode);$(id).setAttribute('aria-pressed',String(id===mode));}snippet();});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(JSON.stringify(result,null,2));$('copy').textContent='Copied';setTimeout(()=>$('copy').textContent='Copy JSON',1200);}catch{diagnostic('Clipboard unavailable. Expand events to inspect their JSON.');}});
reset();

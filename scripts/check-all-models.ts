// check all provider models live
import fs from "fs";
const providers: any[] = JSON.parse(fs.readFileSync("config/providers.json","utf8")).providers;
const env = fs.readFileSync(".env","utf8");
function getEnv(key:string):string|undefined{
  const m = env.match(new RegExp(`^${key}=(.*)$`,"m"));
  if(m) return m[1].trim().replace(/^["']|["']$/g,"");
  return process.env[key];
}
for(const p of providers) if(p.apiKeyEnv){ const v=getEnv(p.apiKeyEnv); if(v) process.env[p.apiKeyEnv]=v; }
function headersFor(p:any):Record<string,string>{
  const h:Record<string,string>={"Content-Type":"application/json"};
  const key=p.apiKeyEnv?process.env[p.apiKeyEnv]:undefined;
  if(p.id==="opencode") h["x-opencode-client"]="desktop";
  else if(p.id==="openrouter"){ h["HTTP-Referer"]="http://localhost:3000"; h["X-Title"]="MiniRoutingAI"; if(key) h["Authorization"]=`Bearer ${key}`; }
  else if(key) h["Authorization"]=`Bearer ${key}`;
  return h;
}
async function test(pId:string, model:string){
  const p=providers.find(x=>x.id===pId)!;
  const url=p.baseURL.replace(/\/$/,"")+"/chat/completions";
  const body=JSON.stringify({model,messages:[{role:"user",content:"hi"}],max_tokens:5,stream:false});
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), 10000);
  try{
    const res=await fetch(url,{method:"POST",headers:headersFor(p),body,signal:ctrl.signal});
    const txt=await res.text(); let j:any=null; try{j=JSON.parse(txt);}catch{}; const msg=j?.error?.message ?? txt; const lower=String(msg).toLowerCase();
    const isUnavailable=lower.includes("unavailable")||lower.includes("capacity")||lower.includes("overloaded")||lower.includes("no available channel")||lower.includes("rate limit");
    const isNotFound=lower.includes("model not found")||lower.includes("model_not_found");
    return {pId,model,status:res.status,ok:res.ok,isUnavailable,isNotFound,msg:String(msg).slice(0,300)};
  }catch(e:any){ return {pId,model,status:0,ok:false,isUnavailable:String(e).toLowerCase().includes("unavailable"),msg:String(e).slice(0,300)} }finally{clearTimeout(t);}
}
const all:[string,string][]=[];
for(const p of providers) for(const m of p.models) all.push([p.id,m]);
console.log("Testing ALL provider models:", all.length);
const results:any[]=[];
for(const [pId,model] of all){
  const r=await test(pId,model);
  results.push(r);
  const flag=r.isUnavailable?"UNAVAILABLE":r.ok?"OK":r.isNotFound?"NOT_FOUND":"ERR_"+r.status;
  console.log(`${flag}  ${pId}/${model}  status=${r.status}  msg=${r.msg}`);
  await new Promise(res=>setTimeout(res,500));
}
const ok=results.filter(r=>r.ok);
const unav=results.filter(r=>r.isUnavailable);
console.log(`\nOK:${ok.length} UNAVAILABLE:${unav.length} OTHER:${results.length-ok.length-unav.length}`);
fs.writeFileSync("scripts/check-all-models-result.json", JSON.stringify(results,null,2));

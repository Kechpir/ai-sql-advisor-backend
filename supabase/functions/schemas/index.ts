// @ts-nocheck
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, OPTIONS, DELETE"};
function checksum(input){let h=0;for(let i=0;i<input.length;i++){h=(h<<5)-h+input.charCodeAt(i);h|=0}return("00000000"+(h>>>0).toString(16)).slice(-8)}
function diffSchemas(a,b){const d={added:[],removed:[],changed:[]},A=Object.keys(a?.tables||{}),B=Object.keys(b?.tables||{});for(const t of B)if(!A.includes(t))d.added.push({table:t});for(const t of A)if(!B.includes(t))d.removed.push({table:t});for(const t of B)if(A.includes(t)){const ac=(a.tables[t]?.columns||[]).map(c=>c.name),bc=(b.tables[t]?.columns||[]).map(c=>c.name);const add=bc.filter(x=>!ac.includes(x)),rem=ac.filter(x=>!bc.includes(x));if(add.length||rem.length)d.changed.push({table:t,addedCols:add,removedCols:rem})}return d}
function b64u(s){s=s.replace(/-/g,"+").replace(/_/g,"/");const p=s.length%4;if(p)s+="=".repeat(4-p);const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return new TextDecoder().decode(a)}
function uidFromJwt(jwt){try{const parts=jwt.split(".");if(parts.length!==3)return null;const payload=JSON.parse(b64u(parts[1]));return payload?.sub??null}catch{return null}}
Deno.serve(async (req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  try{
    const SUPABASE_URL=Deno.env.get("SUPABASE_URL"); if(!SUPABASE_URL) return new Response(JSON.stringify({error:"Missing SUPABASE_URL"}),{status:500,headers:{"Content-Type":"application/json",...cors}});
    const auth=req.headers.get("authorization")||req.headers.get("Authorization");
    if(!auth||!auth.toLowerCase().startsWith("bearer ")) return new Response(JSON.stringify({error:"unauthorized"}),{status:401,headers:{"Content-Type":"application/json",...cors}});
    const jwt=auth.split(" ")[1]; const uid=uidFromJwt(jwt); if(!uid) return new Response(JSON.stringify({error:"invalid_jwt"}),{status:401,headers:{"Content-Type":"application/json",...cors}});
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
    const sb=createClient(SUPABASE_URL,"anon",{auth:{persistSession:false},global:{headers:{Authorization:`Bearer ${jwt}`}}});
    const bucket="schemas";

    if(req.method==="GET"){
      const {data,error}=await sb.storage.from(bucket).list(`${uid}/`,{sortBy:{column:"updated_at",order:"desc"}});
      if(error) throw error;
      const items=(data||[]).filter(x=>x.name?.endsWith(".json")).map(x=>({name:x.name.replace(/\.json$/i,""),updated_at:x.updated_at,size:x.size??null}));
      return new Response(JSON.stringify({items}),{status:200,headers:{"Content-Type":"application/json",...cors}});
    }

    if(req.method!=="POST" && req.method!=="DELETE")
      return new Response(JSON.stringify({error:"Use GET, POST or DELETE"}),{status:405,headers:{"Content-Type":"application/json",...cors}});

    const body=req.method==="POST"?await req.json().catch(()=>({})):{}, op=body?.op;

    if(req.method==="POST" && op==="save"){
      const {name,schema,dialect="postgres"}=body||{};
      if(!name||typeof schema!=="object") return new Response(JSON.stringify({error:"Invalid 'name' or 'schema'"}),{status:400,headers:{"Content-Type":"application/json",...cors}});
      const meta={name,dialect,updated_at:new Date().toISOString(),checksum:checksum(JSON.stringify(schema))};
      const blob=new Blob([JSON.stringify({meta,schema},null,2)],{type:"application/json"});
      const path=`${uid}/${name}.json`;
      const {error}=await sb.storage.from(bucket).upload(path,blob,{upsert:true,contentType:"application/json; charset=utf-8"});
      if(error) throw error; return new Response(JSON.stringify({ok:true,meta}),{status:200,headers:{"Content-Type":"application/json",...cors}});
    }

    if(req.method==="DELETE" || (req.method==="POST" && op==="delete")){
      const name=req.method==="DELETE"?(new URL(req.url)).searchParams.get("name"):body?.name;
      if(!name) return new Response(JSON.stringify({error:"Field 'name' required"}),{status:400,headers:{"Content-Type":"application/json",...cors}});
      const {error}=await sb.storage.from(bucket).remove([`${uid}/${name}.json`]);
      if(error) throw error; return new Response(JSON.stringify({deleted:name}),{status:200,headers:{"Content-Type":"application/json",...cors}});
    }

    if(req.method==="POST" && op==="diff"){
      const {name,new_schema}=body||{};
      const {data,error}=await sb.storage.from(bucket).download(`${uid}/${name}.json`);
      if(error||!data) return new Response(JSON.stringify({error:"Schema not found"}),{status:404,headers:{"Content-Type":"application/json",...cors}});
      const old=JSON.parse(await data.text()); const diff=diffSchemas(old?.schema||{},new_schema||{});
      return new Response(JSON.stringify({diff}),{status:200,headers:{"Content-Type":"application/json",...cors}});
    }

    if(req.method==="POST" && op==="update"){
      const {name,new_schema}=body||{}; const path=`${uid}/${name}.json`;
      const cur=await sb.storage.from(bucket).download(path);
      if(cur.error||!cur.data) return new Response(JSON.stringify({error:"Schema not found"}),{status:404,headers:{"Content-Type":"application/json",...cors}});
      const old=JSON.parse(await cur.data.text()); const oldC=old?.meta?.checksum;
      const newStr=JSON.stringify(new_schema||{}); const newC=checksum(newStr);
      if(newC===oldC) return new Response(JSON.stringify({updated:false,reason:"Изменений не обнаружено."}),{status:200,headers:{"Content-Type":"application/json",...cors}});
      const meta={name,updated_at:new Date().toISOString(),checksum:newC};
      const blob=new Blob([JSON.stringify({meta,schema:new_schema},null,2)],{type:"application/json"});
      const up=await sb.storage.from(bucket).upload(path,blob,{upsert:true,contentType:"application/json; charset=utf-8"});
      if(up.error) throw up.error; return new Response(JSON.stringify({updated:true,reason:"Схема обновлена.",meta}),{status:200,headers:{"Content-Type":"application/json",...cors}});
    }

    if(req.method==="POST" && op==="get"){
      const {name}=body||{}; const dl=await sb.storage.from(bucket).download(`${uid}/${name}.json`);
      if(dl.error) throw dl.error; const file=JSON.parse(await dl.data.text());
      return new Response(JSON.stringify(file),{status:200,headers:{"Content-Type":"application/json",...cors}});
    }

    return new Response(JSON.stringify({error:`Unknown op: ${op}`}),{status:400,headers:{"Content-Type":"application/json",...cors}});
  }catch(e){ return new Response(JSON.stringify({error:String(e?.message||e)}),{status:500,headers:{"Content-Type":"application/json",...cors}}) }
});

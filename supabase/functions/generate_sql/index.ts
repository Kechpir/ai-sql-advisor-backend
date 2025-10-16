// @ts-nocheck
// supabase/functions/generate_sql/index.ts
// Генерация безопасного SQL + учёт токенов в public.profiles (tokens_used/tokens_limit)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// --- безопасный фильтр ---
function isDangerous(sql) {
  const forbidden = [/\bDROP\b/i, /\bDELETE\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /\bMERGE\b/i, /\bGRANT\b/i, /\bREVOKE\b/i, /\bCREATE\b/i];
  const hit = forbidden.find((re) => re.test(sql));
  return hit ? { blocked: true, reason: `Опасный оператор: ${hit}` } : { blocked: false };
}

function buildSystemPrompt(dialect) {
  return [
    "You are an expert SQL generator.",
    "Return ONLY a single SQL statement. No prose, no markdown, no triple backticks.",
    "Target dialect: " + dialect + ".",
    "STRICT RULES:",
    "- Use ONLY real table and column names from the provided schema. Do not invent or rename anything.",
    "- Prefer explicit JOINs; qualify columns when helpful.",
    "- NEVER use destructive/DDL statements (DROP/DELETE/ALTER/TRUNCATE/UPDATE/INSERT/MERGE/GRANT/REVOKE/CREATE).",
    "- If user asks for mutation, rewrite as a safe SELECT."
  ].join(" ");
}

function norm(x){ return (x||"").replace(/"/g,"").toLowerCase(); }
function parseAliases(sql){
  const m = {}; const re = /\b(from|join)\s+(?:"([^"]+)"|([a-zA-Z_][\w$]*))\s+(?:as\s+)?(?:"([^"]+)"|([a-zA-Z_][\w$]*))/gi;
  let r; while((r=re.exec(sql))!==null){ const t=norm(r[2]??r[3]); const a=norm(r[4]??r[5]); if(t&&a) m[a]=t; }
  return m;
}
function extractRefs(sql){
  const out=[]; const re=/(?:(?:"([^"]+)")|([a-zA-Z_][\w$]*))\s*\.\s*(?:(?:"([^"]+)")|([a-zA-Z_][\w$]*))/g;
  let r; while((r=re.exec(sql))!==null){ const ta=norm(r[1]??r[2]); const c=norm(r[3]??r[4]); if(ta&&c) out.push({tableOrAlias:ta,column:c});}
  return out;
}
function parseSchema(raw){
  try {
    const obj = typeof raw==="string"? JSON.parse(raw): raw;
    if(!obj||typeof obj!=="object") return null;
    const tables=obj.tables??{}; const t2={};
    for(const [t,def] of Object.entries(tables)){
      t2[String(t).toLowerCase()]={columns:(def?.columns??[]).map(c=>({name:c.name}))};
    }
    return {tables:t2};
  } catch { return null; }
}
function validateColumns(schema, sql){
  const alias=parseAliases(sql), refs=extractRefs(sql), bad=[];
  for(const {tableOrAlias,column} of refs){
    const base=alias[tableOrAlias]||tableOrAlias;
    const t=schema.tables?.[base];
    if(!t){ bad.push(`${tableOrAlias}.${column}`); continue; }
    if(!(t.columns||[]).some(c=>norm(c.name)===column)) bad.push(`${base}.${column}`);
  }
  return { ok: bad.length===0, unknown: bad };
}

// --- JWT → uid ---
function b64u(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); const p=s.length%4; if(p) s+="=".repeat(4-p); const b=atob(s); const a=new Uint8Array(b.length); for(let i=0;i<b.length;i++) a[i]=b.charCodeAt(i); return new TextDecoder().decode(a); }
function uidFromJwt(jwt){ try{ const parts=jwt.split("."); if(parts.length!==3) return null; const payload=JSON.parse(b64u(parts[1])); return payload?.sub??null; }catch{ return null; }}

// --- OpenAI call ---
async function callOpenAI(nl, schemaText, dialect="postgres"){
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if(!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json"},
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      top_p: 0.9,
      messages: [{role:"system", content: buildSystemPrompt(dialect)},
                 {role:"user", content: schemaText ? `Database schema (JSON):\n${schemaText}\n\nUser request: ${nl}` : `User request: ${nl}`}]
    })
  });
  if(!resp.ok){ const t=await resp.text(); throw new Error(`OpenAI error ${resp.status}: ${t}`); }
  const data = await resp.json();
  const sql = data?.choices?.[0]?.message?.content?.trim?.() ?? "";
  const usage = data?.usage ?? null; // {prompt_tokens, completion_tokens, total_tokens}
  if(!sql) throw new Error("Empty SQL from model");
  return { sql, usage };
}

Deno.serve( async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error:"Use POST" }), { status:405, headers:{ "Content-Type":"application/json", ...corsHeaders }});
    }

    const auth = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!auth?.toLowerCase().startsWith("bearer ")) {
      return new Response(JSON.stringify({ error:"unauthorized" }), { status:401, headers:{ "Content-Type":"application/json", ...corsHeaders }});
    }
    const jwt = auth.split(" ")[1];
    const uid = uidFromJwt(jwt);
    if (!uid) return new Response(JSON.stringify({ error:"invalid_jwt" }), { status:401, headers:{ "Content-Type":"application/json", ...corsHeaders }});

    const payload = await req.json();
    if (!payload?.nl || typeof payload.nl !== "string") {
      return new Response(JSON.stringify({ error:"Field 'nl' is required (string)" }), { status:400, headers:{ "Content-Type":"application/json", ...corsHeaders }});
    }
    const dialect = payload.dialect || "postgres";
    let schemaText;
    if (payload.schema && typeof payload.schema === "object") { try { schemaText = JSON.stringify(payload.schema); } catch {} }
    else if (typeof payload.schema === "string") { schemaText = payload.schema; }

    // --- подключаемся к Supabase как пользователь (для RLS на profiles) ---
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
    const sb = createClient(SUPABASE_URL, "anon", { auth: { persistSession:false }, global: { headers: { Authorization: `Bearer ${jwt}` }}});

    // 1) читаем профиль (лимит/использование)
    const { data: me, error: e1 } = await sb.from("profiles").select("tokens_used,tokens_limit,plan").eq("id", uid).maybeSingle();
    if (e1) throw e1;
    const used = Number(me?.tokens_used || 0);
    const limit = Number(me?.tokens_limit || 0);
    if (limit > 0 && used >= limit) {
      return new Response(JSON.stringify({ blocked:true, reason:"Лимит токенов исчерпан. Обновите тариф или пополните баланс." }), {
        status: 402, headers: { "Content-Type":"application/json", ...corsHeaders }
      });
    }

    // 2) вызываем модель
    const { sql, usage } = await callOpenAI(payload.nl, schemaText, dialect);

    // 3) валидируем SQL
    const danger = isDangerous(sql);
    if (danger.blocked) {
      return new Response(JSON.stringify({ sql:null, blocked:true, reason: danger.reason, usage }), { status:200, headers:{ "Content-Type":"application/json", ...corsHeaders }});
    }
    if (schemaText) {
      const parsed = parseSchema(schemaText);
      if (parsed) {
        const check = validateColumns(parsed, sql.toLowerCase());
        if (!check.ok) {
          return new Response(JSON.stringify({ sql:null, blocked:true, reason:`В запросе есть несуществующие поля: ${check.unknown.join(", ")}`, usage }), {
            status:200, headers:{ "Content-Type":"application/json", ...corsHeaders }
          });
        }
      }
    }

    // 4) учитываем токены (если usage пришёл)
    const delta = Number(usage?.total_tokens || 0);
    if (delta > 0) {
      // RLS разрешает обновлять только свою строку
      const { error: e2 } = await sb.rpc("add_tokens_used_safe", { p_delta: delta }).catch(async () => {
        // если функции нет — fallback на update
        const { error } = await sb.from("profiles").update({ tokens_used: used + delta }).eq("id", uid);
        return { error };
      });
      // e2 можно игнорировать — главное не блокировать ответ пользователю
    }

    return new Response(JSON.stringify({ sql, blocked:false, usage }), { status:200, headers:{ "Content-Type":"application/json", ...corsHeaders }});
  } catch (e) {
    return new Response(JSON.stringify({ error:String(e?.message ?? e) }), { status:500, headers:{ "Content-Type":"application/json", ...corsHeaders }});
  }
});

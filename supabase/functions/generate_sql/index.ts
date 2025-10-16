// supabase/functions/generate_sql/index.ts
// Edge Function (Deno). Генерит SQL из запроса на естественном языке через OpenAI.
// ВАЖНО: функция НИЧЕГО не выполняет в БД — только предлагает SQL. Только безопасные SELECT.
// ===== CORS =====
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
// ===== Утилиты безопасности =====
function isDangerous(sql: string) {
  const forbidden = [
    /\bDROP\b/i,
    /\bDELETE\b/i,
    /\bALTER\b/i,
    /\bTRUNCATE\b/i,
    /\bUPDATE\b/i,
    /\bINSERT\b/i,
    /\bMERGE\b/i,
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /\bCREATE\b/i
  ];
  const hit = forbidden.find((re) => re.test(sql));
  return hit ? { blocked: true, reason: `Опасный оператор: ${hit}` } : { blocked: false };
}
// ===== Системный промпт (усиленный) =====
function buildSystemPrompt(dialect: string) {
  return [
    "You are an expert SQL generator.",
    "Return ONLY a single SQL statement. No prose, no markdown, no triple backticks.",
    "Target dialect: " + dialect + ".",
    "STRICT RULES:",
    "- Use ONLY real table and column names from the provided schema. Do not invent or rename anything.",
    "- If the schema shows a relation like employees.reports_to → employees.employeeid, use those exact names.",
    "- Prefer explicit JOINs; qualify columns when helpful.",
    "- NEVER use destructive/DDL statements (DROP/DELETE/ALTER/TRUNCATE/UPDATE/INSERT/MERGE/GRANT/REVOKE/CREATE).",
    "- If a user asks for mutation, rewrite as a safe SELECT that inspects data instead."
  ].join(" ");
}
// ===== Парсинг и валидация SQL на существование колонок =====
function norm(x: string) { return (x || "").replace(/"/g, "").toLowerCase(); }
function parseAliases(sql: string) {
  const aliasMap: Record<string,string> = {};
  const re = /\b(from|join)\s+(?:"([^"]+)"|([a-zA-Z_][\w$]*))\s+(?:as\s+)?(?:"([^"]+)"|([a-zA-Z_][\w$]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const tableName = norm(m[2] ?? m[3]);
    const aliasName = norm(m[4] ?? m[5]);
    if (tableName && aliasName) aliasMap[aliasName] = tableName;
  }
  return aliasMap;
}
function extractTableColumnRefs(sql: string) {
  const refs: Array<{tableOrAlias:string;column:string}> = [];
  const re = /(?:(?:"([^"]+)")|([a-zA-Z_][\w$]*))\s*\.\s*(?:(?:"([^"]+)")|([a-zA-Z_][\w$]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const tableOrAlias = norm(m[1] ?? m[2]);
    const column = norm(m[3] ?? m[4]);
    if (tableOrAlias && column) refs.push({ tableOrAlias, column });
  }
  return refs;
}
function parseSchema(raw: any) {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object") return null;
    const tables = obj.tables ?? {};
    const normTables: any = {};
    for (const [tName, tDef] of Object.entries<any>(tables)) {
      const key = (tName as string).toLowerCase();
      const cols = (tDef?.columns ?? []).map((c: any) => ({ name: c.name }));
      normTables[key] = { columns: cols };
    }
    return { tables: normTables };
  } catch {
    return null;
  }
}
function validateColumns(schema: any, sql: string) {
  const aliasMap = parseAliases(sql);
  const refs = extractTableColumnRefs(sql);
  const unknown: string[] = [];
  for (const { tableOrAlias, column } of refs) {
    const baseTable = aliasMap[tableOrAlias] || tableOrAlias;
    const tDef = schema.tables?.[baseTable];
    if (!tDef) { unknown.push(`${tableOrAlias}.${column}`); continue; }
    const hasCol = (tDef.columns || []).some((c: any) => norm(c.name) === column);
    if (!hasCol) unknown.push(`${baseTable}.${column}`);
  }
  return { ok: unknown.length === 0, unknown };
}
// ===== Генерация SQL через OpenAI =====
async function generateSQL(nl: string, schemaText?: string, dialect = "postgres") {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const system = buildSystemPrompt(dialect);
  const user = schemaText ? `Database schema (JSON):\n${schemaText}\n\nUser request: ${nl}` : `User request: ${nl}`;
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      top_p: 0.9,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!resp.ok) { const text = await resp.text(); throw new Error(`OpenAI error ${resp.status}: ${text}`); }
  const data = await resp.json();
  const sql = data?.choices?.[0]?.message?.content?.trim?.() ?? "";
  if (!sql) throw new Error("Empty SQL from model");
  return sql;
}
// ===== HTTP-обработчик =====
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders }});
    }
    const payload = await req.json();
    if (!payload?.nl || typeof payload.nl !== "string") {
      return new Response(JSON.stringify({ error: "Field 'nl' is required (string)" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }});
    }
    const dialect = payload.dialect || "postgres";
    let schemaText: string | undefined;
    if (payload.schema && typeof payload.schema === "object") { try { schemaText = JSON.stringify(payload.schema); } catch { schemaText = undefined; } }
    else if (typeof payload.schema === "string") { schemaText = payload.schema; }

    const sql = await generateSQL(payload.nl, schemaText, dialect);
    const danger = isDangerous(sql);
    if (danger.blocked) {
      return new Response(JSON.stringify({ sql: null, blocked: true, reason: danger.reason }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }});
    }
    if (schemaText) {
      const parsed = parseSchema(schemaText);
      if (parsed) {
        const check = validateColumns(parsed, sql.toLowerCase());
        if (!check.ok) {
          return new Response(JSON.stringify({ sql: null, blocked: true, reason: `В запросе есть несуществующие поля: ${check.unknown.join(", ")}` }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }});
        }
      }
    }
    return new Response(JSON.stringify({ sql, blocked: false }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }});
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }});
  }
});

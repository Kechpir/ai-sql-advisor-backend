// @ts-nocheck
// supabase/functions/generate_sql/index.ts
// Генерация SQL через OpenAI + предупреждения и готовые варианты (обычный и с SAVEPOINT)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function buildSystemPrompt(dialect) {
  return [
    "You are an expert SQL generator.",
    "Return ONLY a single SQL statement. No prose, no markdown, no triple backticks.",
    "Target dialect: " + dialect + ".",
    "RULES:",
    "- Use ONLY real table and column names from the provided schema if present.",
    "- Prefer explicit JOINs; qualify columns when helpful.",
    "- If user asks for mutating ops (DELETE/UPDATE/INSERT/etc), generate them plainly — do not add transactions.",
  ].join(" ");
}

async function callOpenAI(nl, schemaText, dialect = "postgres") {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      top_p: 0.9,
      messages: [
        { role: "system", content: buildSystemPrompt(dialect) },
        {
          role: "user",
          content: schemaText
            ? `Database schema (JSON):\n${schemaText}\n\nUser request: ${nl}`
            : `User request: ${nl}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI error ${resp.status}: ${t}`);
  }

  const data = await resp.json();
  const sql = data?.choices?.[0]?.message?.content?.trim?.() ?? "";
  const usage = data?.usage ?? null;
  if (!sql) throw new Error("Empty SQL from model");

  return { sql, usage };
}

const DANGER_RE = /\b(DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|DELETE|UPDATE|INSERT|MERGE)\b/i;

function detectDanger(sql) {
  const found = new Set();
  const tokens = ["DROP","ALTER","TRUNCATE","CREATE","GRANT","REVOKE","DELETE","UPDATE","INSERT","MERGE"];
  for (const t of tokens) {
    const re = new RegExp(`\\b${t}\\b`, "i");
    if (re.test(sql)) found.add(t);
  }
  return Array.from(found);
}

function wrapWithSavepoint(sql, savepointName = "ai_guard") {
  return [
    "BEGIN;",
    `SAVEPOINT ${savepointName};`,
    sql,
    `ROLLBACK TO SAVEPOINT ${savepointName}; -- если нужно отменить`,
    "COMMIT; -- когда уверены в результате",
  ].join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const payload = await req.json().catch(() => ({}));
    const nl = payload?.nl ?? "";
    if (!nl || typeof nl !== "string") {
      return new Response(JSON.stringify({ error: "Field 'nl' is required (string)" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const dialect = payload?.dialect || "postgres";
    let schemaText;
    if (payload?.schema && typeof payload.schema === "object") {
      try { schemaText = JSON.stringify(payload.schema); } catch {}
    } else if (typeof payload?.schema === "string") {
      schemaText = payload.schema;
    }

    const { sql, usage } = await callOpenAI(nl.trim(), schemaText, dialect);

    const dangers = detectDanger(sql);
    const isDanger = dangers.length > 0;

    const variantPlain = sql;
    const variantSavepoint = isDanger ? wrapWithSavepoint(sql) : null;

    return new Response(
      JSON.stringify({
        blocked: false,
        sql: variantPlain,
        withSafety: variantSavepoint,
        variantPlain,
        variantSavepoint,
        dangers,
        usage,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});

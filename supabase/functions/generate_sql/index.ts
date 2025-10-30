// @ts-nocheck
// Supabase Edge Function: generate_sql
// Генерация SQL через OpenAI с учётом выбранного диалекта
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function buildSystemPrompt(dialect) {
  return [
    "Ты — эксперт SQL-генератор.",
    `Текущий SQL диалект: ${dialect.toUpperCase()}.`,
    "Возвращай только корректный SQL без объяснений.",
    "Используй реальные таблицы из схемы, если они даны.",
    "Добавляй SAVEPOINT-логику только для опасных операций (DROP, DELETE, ALTER и т.д.)."
  ].join(" ");
}
async function callOpenAI(nl, schemaText, dialect = "postgres") {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY не задан");
  const prompt = `
Ты SQL-ассистент.
Сгенерируй SQL-запрос для диалекта ${dialect.toUpperCase()}.
Схема БД:
${schemaText || "(пусто)"}
Запрос пользователя:
"${nl}"
`.trim();
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      top_p: 0.9,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(dialect)
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(()=>"");
    throw new Error(`OpenAI error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const sql = data?.choices?.[0]?.message?.content?.trim() || "";
  if (!sql) throw new Error("Модель вернула пустой SQL");
  return {
    sql,
    usage: data?.usage || {}
  };
}
// ⚙️ Определение опасных операций
function detectDangerousOps(sql) {
  const tokens = [
    "DROP",
    "ALTER",
    "TRUNCATE",
    "DELETE",
    "UPDATE",
    "INSERT",
    "MERGE"
  ];
  return tokens.filter((t)=>new RegExp(`\\b${t}\\b`, "i").test(sql));
}
// 🧩 Обёртка SAVEPOINT (для опасных операций)
function wrapWithSavepoint(sql, savepointName = "ai_guard") {
  return [
    "BEGIN;",
    `SAVEPOINT ${savepointName};`,
    sql,
    `ROLLBACK TO SAVEPOINT ${savepointName}; -- безопасный откат`,
    "COMMIT;"
  ].join("\n");
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({
        error: "Use POST"
      }), {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
    const payload = await req.json().catch(()=>({}));
    const nl = payload?.nl ?? "";
    const schema = payload?.schema ?? "";
    const dialect = payload?.dialect ?? "postgres";
    if (!nl || typeof nl !== "string") {
      return new Response(JSON.stringify({
        error: "Поле 'nl' обязательно"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }
    const schemaText = typeof schema === "object" ? JSON.stringify(schema) : String(schema);
    const { sql, usage } = await callOpenAI(nl.trim(), schemaText, dialect);
    // Определяем, есть ли опасные операции
    const dangers = detectDangerousOps(sql);
    const hasDanger = dangers.length > 0;
    // ⚡ Возвращаем только SAFEPOINT для опасных запросов
    const finalSQL = hasDanger ? wrapWithSavepoint(sql) : sql;
    const response = {
      sql,
      withSafety: finalSQL,
      raw: sql,
      warnings: hasDanger ? [
        `⚠️ Обнаружены потенциально опасные операции: ${dangers.join(", ")}`
      ] : [],
      usage
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: e?.message || String(e)
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders
      }
    });
  }
});

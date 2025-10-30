// @ts-nocheck
// Supabase Edge Function: generate_sql
// Генерация SQL через OpenAI с учётом диалекта (Postgres, MySQL, SQLite и т.д.)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 🔧 Системный промпт
function buildSystemPrompt(dialect: string) {
  return [
    "Ты — эксперт SQL-генератор.",
    "Возвращай только корректный SQL без объяснений.",
    `Текущий SQL диалект: ${dialect.toUpperCase()}.`,
    "Используй реальные таблицы и колонки из схемы, если они предоставлены.",
    "Добавь SAVEPOINT-логику для опасных операций (DROP, DELETE, ALTER и т.д.).",
  ].join(" ");
}

// 🔧 Основная функция OpenAI
async function callOpenAI(nl: string, schemaText?: string, dialect = "postgres") {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY не задан");

  const prompt = `
Ты SQL-ассистент. 
Пользователь просит сгенерировать SQL-запрос для диалекта ${dialect.toUpperCase()}.

Схема базы данных (JSON или текст):
${schemaText || "(пусто)"}

Текст запроса пользователя:
"${nl}"

Сгенерируй корректный SQL под этот диалект.
Если какой-то синтаксис не поддерживается — используй ближайший аналог.
  `.trim();

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
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const sql = data?.choices?.[0]?.message?.content?.trim() || "";
  const usage = data?.usage || {};
  if (!sql) throw new Error("Модель вернула пустой SQL");

  return { sql, usage };
}

// 🚨 Проверка на опасные операции
function detectDangerousOps(sql: string) {
  const tokens = ["DROP", "ALTER", "TRUNCATE", "DELETE", "UPDATE", "INSERT", "MERGE"];
  return tokens.filter((t) => new RegExp(`\\b${t}\\b`, "i").test(sql));
}

// 🚧 Обёртка в SAVEPOINT
function wrapWithSavepoint(sql: string, savepointName = "ai_guard") {
  return [
    "BEGIN;",
    `SAVEPOINT ${savepointName};`,
    sql,
    `ROLLBACK TO SAVEPOINT ${savepointName}; -- безопасный откат`,
    "COMMIT;",
  ].join("\n");
}

// 🧠 Основная функция Supabase Edge
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
    const nl: string = payload?.nl ?? "";
    const schema = payload?.schema ?? "";
    const dialect: string = payload?.dialect ?? "postgres";

    if (!nl || typeof nl !== "string") {
      return new Response(JSON.stringify({ error: "Поле 'nl' обязательно" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const schemaText =
      typeof schema === "object" ? JSON.stringify(schema) : String(schema);

    const { sql, usage } = await callOpenAI(nl.trim(), schemaText, dialect);

    const dangers = detectDangerousOps(sql);
    const hasDanger = dangers.length > 0;

    const response = {
      sql,
      withSafety: hasDanger ? wrapWithSavepoint(sql) : sql,
      raw: sql,
      warnings: hasDanger
        ? [`⚠️ Обнаружены потенциально опасные операции: ${dangers.join(", ")}`]
        : [],
      usage,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message || String(e) }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
});

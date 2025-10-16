// @ts-nocheck
// supabase/functions/fetch_schema/index.ts
// Edge Function (Deno). Читает схему таблиц из PostgreSQL по db_url (read-only) и возвращает JSON структуры.
// Работает в "компромиссном" режиме безопасности (READ ONLY), без доступа к данным пользователя.

import { Client } from "https://deno.land/x/postgres@v0.17.2/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function badRequest(msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // Parse body
  let payload;
  try { payload = await req.json(); } catch { return badRequest("Invalid JSON body"); }

  const dbUrl = payload?.db_url?.trim();
  if (!dbUrl) return badRequest("Field 'db_url' is required");

  const schema = (payload?.schema || "public").trim();
  const maxTables = Math.min(Math.max(Number(payload?.maxTables || 200), 1), 2000);

  const client = new Client(dbUrl);

  try {
    await client.connect();

    // Secure read-only session
    await client.queryArray("BEGIN READ ONLY");
    await client.queryArray("SET LOCAL statement_timeout = '5s'");
    await client.queryArray("SET LOCAL search_path = pg_catalog, information_schema");

    // Safety gate (soft)
    const gate = await client.queryObject(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables t
        WHERE t.table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
          AND has_table_privilege(
            current_user,
            quote_ident(t.table_schema) || '.' || quote_ident(t.table_name),
            'SELECT'
          )
      ) AS has_select;
    `);

    const ENFORCE_CATALOG_ONLY = (Deno.env.get("ENFORCE_CATALOG_ONLY") ?? "true") !== "false";
    let warning = null;

    if (gate.rows[0]?.has_select && ENFORCE_CATALOG_ONLY) {
      return new Response(JSON.stringify({
        blocked: true,
        code: "ROLE_NOT_CATALOG_ONLY",
        reason: "Подключённый пользователь имеет доступ к данным. Используйте роль без SELECT на пользовательские таблицы (catalog-only)."
      }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } });
    } else if (gate.rows[0]?.has_select) {
      warning = {
        code: "ROLE_NOT_CATALOG_ONLY",
        reason: "Работаем в компромиссном режиме: роль имеет доступ к данным, но сессия защищена READ ONLY."
      };
    }

    // Таблицы
    const tablesRes = await client.queryObject`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schema}
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
      LIMIT ${maxTables};
    `;
    const tableNames = tablesRes.rows.map((r) => r.table_name);

    if (tableNames.length === 0) {
      await client.end();
      return new Response(JSON.stringify({
        schema, tables: {}, countTables: 0, warning
      }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Колонки
    const columnsRes = await client.queryObject`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = ${schema}
        AND table_name = ANY(${tableNames})
      ORDER BY table_name, ordinal_position;
    `;

    // PK
    const pksRes = await client.queryObject`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = ${schema}
        AND tc.table_name = ANY(${tableNames});
    `;

    // FK
    const fksRes = await client.queryObject`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name  AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = ${schema}
        AND tc.table_name = ANY(${tableNames});
    `;

    await client.queryArray("COMMIT");
    await client.end();

    // Сборка JSON
    const tables: any = {};
    for (const t of tableNames) tables[t] = { columns: [], primaryKey: [], foreignKeys: [] };
    for (const c of columnsRes.rows) tables[c.table_name].columns.push({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES" });
    for (const pk of pksRes.rows) tables[pk.table_name].primaryKey.push(pk.column_name);
    for (const fk of fksRes.rows) tables[fk.table_name].foreignKeys.push({ column: fk.column_name, ref_table: fk.foreign_table_name, ref_column: fk.foreign_column_name });

    const result = { dialect: "postgres", schema, countTables: tableNames.length, tables, warning };
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });

  } catch (e) {
    const msg = typeof e?.message === "string" ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
});

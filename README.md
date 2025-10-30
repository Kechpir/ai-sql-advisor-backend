## 🧠 AI SQL Advisor

> Умный AI-помощник для генерации SQL-запросов из естественного языка.
> Подключается к вашей базе (Postgres / MySQL), анализирует структуру таблиц и предлагает безопасные SQL-запросы в read-only режиме.

---

### 🚀 Основные возможности

* 🔍 Чтение схемы БД без доступа к данным
* 💬 Генерация SQL-запросов на основе текстового описания
* 🧱 Проверка и обёртка опасных операций (`DROP`, `DELETE`, `ALTER`, …)
* 🔒 Read-only безопасность: SQL никогда не выполняется автоматически
* ☁️ Полностью облачная архитектура (Supabase + OpenAI + Neon + Vercel)

---

### 🧩 Архитектура проекта

```
[Пользователь]
   ↓
[Next.js UI (Vercel)]
   ↓
[Supabase Edge Functions]
   ├── fetch_schema — получает структуру БД
   └── generate_sql — создаёт безопасный SQL через OpenAI
   ↓
[База данных (PostgreSQL / MySQL)]
   ↓
[OpenAI API — GPT-4o]
```

---

### ⚙️ Технологии

| Компонент      | Стек / Сервис                  |
| -------------- | ------------------------------ |
| Frontend       | Next.js (TypeScript, Vercel)   |
| Backend        | Supabase Edge Functions (Deno) |
| База данных    | Neon.tech (PostgreSQL)         |
| AI-движок      | OpenAI API (GPT-4o)            |
| Аутентификация | Supabase Auth (Email / Google) |
| Деплой         | GitHub → Vercel                |

---

### 🧪 Пример использования API

**POST** `/functions/v1/generate_sql`

```json
{
  "nl": "Покажи всех пользователей, оформивших заказ за последние 3 дня",
  "schema": { "...": "структура, полученная через fetch_schema" }
}
```

**Ответ:**

```json
{
  "sql": "SELECT u.name, u.email FROM users u JOIN orders o ON u.id = o.user_id WHERE o.created_at > NOW() - INTERVAL '3 days';",
  "withSafety": "BEGIN; SAVEPOINT safe; ... ROLLBACK TO SAVEPOINT safe; COMMIT;",
  "warnings": [],
  "usage": { "total_tokens": 932 }
}
```

---

### 🧱 Локальный запуск (для разработчиков)

```bash
# клонируем репозиторий backend
git clone https://github.com/Kechpir/ai-sql-advisor-backend.git
cd ai-sql-advisor-backend

# установка Supabase CLI
npm install -g supabase

# вход в CLI
supabase login

# деплой функций
supabase functions deploy fetch_schema
supabase functions deploy generate_sql
```

> ⚠️ В README не указываем `project-ref` — используйте свой идентификатор из Supabase Dashboard.

---

### 🧭 Дорожная карта

| Этап                           | Статус       |
| ------------------------------ | ------------ |
| ✅ Генерация SQL                | готово       |
| ✅ Безопасная обёртка SAVEPOINT | готово       |
| ✅ Supabase Edge Functions      | готово       |
| 🚧 UI на Next.js               | доработка UX |
| 🔜 Авторизация и биллинг       | планируется  |
| 🔜 Тарифы и Stripe интеграция  | планируется  |

---

### 🔒 Безопасность

* Только **read-only** операции
* SQL-запросы **не исполняются** автоматически
* Опасные выражения помечаются и оборачиваются в транзакцию
* Секреты хранятся в **Supabase Secrets**
* Публичные ключи (anon) можно коммитить, приватные — нет

---

### ✨ Автор

**Kechpir** — QA-инженер и разработчик, создающий AI-инструменты для безопасной работы с базами данных.
📦 [GitHub → Kechpir](https://github.com/Kechpir)
🌐 [Vercel Demo → ai-sql-advisor-next.vercel.app](https://ai-sql-advisor-next.vercel.app)

---


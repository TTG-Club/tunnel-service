-- Ядро control plane: слаги, ноды, расход трафика.
-- Уникальность слага обеспечивает база, а не код.

-- ---------------------------------------------------------------------------
-- Слаги. Главная сущность: потерять нельзя, менять через API нельзя.
-- ---------------------------------------------------------------------------
create table slugs (
  slug        text primary key,
  -- account_id — это claim sub из токена auth-сервиса, там UUID.
  account_id  uuid not null,
  kind        text not null,
  parent_slug text references slugs (slug),
  world_id    text,
  created_at  timestamptz not null default now(),

  constraint slugs_kind_check check (kind in ('account', 'world')),

  -- 63 — предел метки DNS. Кандидат для аккаунта режется до 30 в коде,
  -- слаг мира = слаг аккаунта + дефис + короткий id и тоже влезает.
  constraint slugs_format_check check (slug ~ '^[a-z0-9]([a-z0-9-]{1,61})[a-z0-9]$'),

  -- Форма записи зависит от вида: у аккаунта нет родителя и мира,
  -- у мира обязательны оба.
  constraint slugs_shape_check check (
    (kind = 'account' and parent_slug is null and world_id is null)
    or (kind = 'world' and parent_slug is not null and world_id is not null)
  )
);

-- Один слаг аккаунта на аккаунт. Два параллельных запроса тикета не должны
-- завести аккаунту два адреса — гонку ловит база, код обрабатывает конфликт.
create unique index slugs_one_per_account
  on slugs (account_id)
  where kind = 'account';

-- Один слаг на мир.
create unique index slugs_one_per_world
  on slugs (account_id, world_id)
  where kind = 'world';

create index slugs_account_idx on slugs (account_id);

-- ---------------------------------------------------------------------------
-- Ноды.
-- ---------------------------------------------------------------------------
create table nodes (
  id           text primary key,
  hostname     text not null,
  region       text,
  status       text not null default 'active',
  last_seen_at timestamptz,

  -- Сверх минимального ядра: последние значения из heartbeat. Нода их и так
  -- присылает, а выбор ноды и наблюдаемость без них слепые.
  tunnels      integer not null default 0,
  streams      integer not null default 0,

  -- Задел под персональный токен ноды вместо общего секрета: хранится хэш,
  -- не сам токен. Пока не используется — авторизация нод идёт по
  -- NODE_SHARED_SECRET. Колонка заведена сразу, чтобы не накатывать её потом
  -- на живых нодах.
  token_hash   text,

  created_at   timestamptz not null default now(),

  constraint nodes_status_check check (status in ('active', 'draining', 'down')),
  constraint nodes_counters_check check (tunnels >= 0 and streams >= 0)
);

create index nodes_alive_idx on nodes (status, last_seen_at desc);

create unique index nodes_token_hash_key on nodes (token_hash) where token_hash is not null;

-- ---------------------------------------------------------------------------
-- Расход трафика.
--
-- usage — агрегат по аккаунту за период, именно его читает выдача тикета.
-- node_usage — вклад каждой ноды, нужен для идемпотентности: нода присылает
-- накопительный счётчик за период, повтор того же батча даёт те же числа и
-- не удваивает агрегат.
-- ---------------------------------------------------------------------------
create table node_usage (
  node_id    text not null,
  account_id uuid not null,
  period     text not null,
  bytes_in   bigint not null default 0,
  bytes_out  bigint not null default 0,
  updated_at timestamptz not null default now(),

  primary key (node_id, account_id, period),
  constraint node_usage_period_check check (period ~ '^\d{4}-\d{2}$'),
  constraint node_usage_bytes_check check (bytes_in >= 0 and bytes_out >= 0)
);

create index node_usage_account_period_idx on node_usage (account_id, period);

create table usage (
  account_id uuid not null,
  period     text not null,
  bytes_in   bigint not null default 0,
  bytes_out  bigint not null default 0,
  updated_at timestamptz not null default now(),

  primary key (account_id, period),
  constraint usage_period_check check (period ~ '^\d{4}-\d{2}$'),
  constraint usage_bytes_check check (bytes_in >= 0 and bytes_out >= 0)
);

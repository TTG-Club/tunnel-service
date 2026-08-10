-- Кому и на какую ноду выдавался тикет.
--
-- Нужна для проверки отчётов о трафике: раньше `/api/internal/usage` принимал
-- ЛЮБОЙ account_id от любой ноды, предъявившей общий секрет. Одна
-- скомпрометированная нода могла записать чужому аккаунту произвольный расход
-- и тихо выключить человеку доступ до конца месяца — квота исчерпана, новый
-- тикет не выдаётся.
--
-- Сервис сам выбирает ноду при выдаче тикета, поэтому знает эту связь; теперь
-- он её ещё и помнит.

create table ticket_grants (
  account_id uuid not null,
  node_id    text not null,
  issued_at  timestamptz not null default now(),

  primary key (account_id, node_id)
);

-- Отчёт приходит по ноде и содержит список аккаунтов: индекс под эту выборку.
create index ticket_grants_node_idx on ticket_grants (node_id);

-- Записи старше нескольких периодов чистятся отдельно; индекс по времени
-- нужен именно для такой уборки.
create index ticket_grants_issued_idx on ticket_grants (issued_at);

-- Vardu Zona Supabase schema

create table if not exists chat_messages (
  id bigserial primary key,
  username text not null,
  text text not null,
  ts bigint not null,
  rank_level integer,
  rank_color text,
  rank_title text,
  supporter boolean default false,
  region text
);

create index if not exists chat_messages_ts_idx
  on chat_messages (ts desc);

create table if not exists vz_users (
  username text primary key,
  data jsonb not null
);

create table if not exists vz_reports (
  id text primary key,
  ts bigint not null,
  reporter text,
  reported text,
  reason text,
  message_id text,
  message_text text,
  source text
);

create index if not exists vz_reports_ts_idx
  on vz_reports (ts desc);

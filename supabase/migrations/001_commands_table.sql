create table if not exists commands (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  result jsonb
);

create index idx_commands_pending on commands (status) where status = 'pending';

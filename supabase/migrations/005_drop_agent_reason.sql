-- seed_artist now lives in metadata jsonb, agent_reason is redundant
alter table tracks drop column agent_reason;

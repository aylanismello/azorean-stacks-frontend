alter table seeds
add column if not exists source text;

alter table seeds
drop constraint if exists seeds_source_check;

alter table seeds
add constraint seeds_source_check
check (source is null or source in ('manual', 're-seed'));

update seeds
set source = case
  when user_id is not null and track_id is not null then 're-seed'
  else 'manual'
end
where source is null;

create index if not exists idx_seeds_source on seeds(source);

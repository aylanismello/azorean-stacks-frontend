-- Add metadata JSONB column to episodes for storing source-specific data
-- (e.g. Lot Radio tracklists indexed by the crawler)
alter table episodes add column if not exists metadata jsonb default '{}'::jsonb;

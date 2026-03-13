-- Add skipped flag to episodes so users can hide irrelevant ones
alter table episodes add column skipped boolean default false;
alter table episodes add column skipped_at timestamptz;

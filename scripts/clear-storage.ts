#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";

const db = getSupabase();

const { data: files } = await db.storage.from("tracks").list("", { limit: 1000 });
if (!files || files.length === 0) {
  console.log("Bucket is already empty");
  process.exit(0);
}

const folders = files.filter((f) => f.id === null || !f.name.includes("."));
const topFiles = files.filter((f) => f.id !== null && f.name.includes("."));

if (topFiles.length > 0) {
  const { error } = await db.storage.from("tracks").remove(topFiles.map((f) => f.name));
  if (error) console.error("Delete top files error:", error);
  else console.log(`Deleted ${topFiles.length} top-level files`);
}

for (const folder of folders) {
  const { data: subFiles } = await db.storage.from("tracks").list(folder.name, { limit: 1000 });
  if (subFiles && subFiles.length > 0) {
    const paths = subFiles.map((f) => `${folder.name}/${f.name}`);
    const { error } = await db.storage.from("tracks").remove(paths);
    if (error) console.error(`Delete error for ${folder.name}:`, error);
    else console.log(`Deleted ${paths.length} files from ${folder.name}`);
  }
}

console.log("Done");

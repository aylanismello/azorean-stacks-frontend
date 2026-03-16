import { Seed } from "@/lib/types";

export function isReseed(seed: Pick<Seed, "source" | "user_id" | "track_id">): boolean {
  return seed.source === "re-seed" || (!seed.source && !!seed.user_id && !!seed.track_id);
}

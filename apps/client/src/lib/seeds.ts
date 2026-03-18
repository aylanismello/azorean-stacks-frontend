import { Seed } from "@/lib/types";

export function isReseed(seed: Pick<Seed, "source" | "user_id" | "track_id">): boolean {
  // "re-seed" = manually planted from a discovered track
  // "auto:approved" = automatically seeded when user approves a track
  // Legacy: no source + has user_id + has track_id
  return (
    seed.source === "re-seed" ||
    seed.source === "auto:approved" ||
    (!seed.source && !!seed.user_id && !!seed.track_id)
  );
}

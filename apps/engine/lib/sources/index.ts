import { ntsSource } from "./nts";
import { lotRadioSource } from "./lotradio";
import type { DiscoverySource } from "../sources";

export const SOURCES: DiscoverySource[] = [ntsSource, lotRadioSource];

export function getSource(name: string): DiscoverySource | undefined {
  return SOURCES.find((s) => s.name === name);
}

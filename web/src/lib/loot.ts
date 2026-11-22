import type { ApiLootSource } from '@fireside/shared';

/** Loot from a player never has a name. */
export function sourceLabel(source: ApiLootSource): string {
  return source.type === 'PLAYER' ? 'Player' : source.name;
}

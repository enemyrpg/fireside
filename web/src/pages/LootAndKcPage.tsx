import { KcPage } from './KcPage';
import { LootPage } from './LootPage';

/**
 * Progress → Loot & KC: the loot number row, By source beside Valuable drops,
 * and Boss KC in full width under them.
 */
export function LootAndKcPage() {
  return (
    <div className="flex flex-col gap-5">
      <LootPage />
      <KcPage />
    </div>
  );
}

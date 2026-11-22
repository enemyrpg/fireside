import { z } from 'zod';
import { comparePets, MAX_PET_NAME_LENGTH, PET_ORIGINS } from '../../game/pets.js';
import { nonNegativeInt, positiveInt, utcTimestamp } from '../common.js';
import { petSourceSchema } from '../events.js';
import { accountId } from './common.js';

// Pets (since 1.27.0). Read only: pets come from the collection
// log ("All Pets") and from `pet.drop` events, never from the owner.

type Issues = z.core.ParsePayload['issues'];

function issue(issues: Issues, input: unknown, path: PropertyKey[], message: string) {
  issues.push({ code: 'custom', message, input, path });
}

/** `…/pets` takes no query parameters. */
export const petsQuerySchema = z.strictObject({});

/** One pet an account has. Each (`accountId`, `itemId`) appears once. */
export const petSchema = z
  .strictObject({
    accountId,
    /** The pet's item in the collection log. Metamorph variants are the same pet. */
    itemId: positiveInt,
    /** From the collection log when it has the pet, else from the plugin. */
    name: z.string().min(1).max(MAX_PET_NAME_LENGTH),
    /**
     * When the pet dropped. `null` when it is not known: a pet from the
     * collection log that was there at the first sync.
     */
    obtainedAt: utcTimestamp.nullable(),
    /**
     * `true` when `obtainedAt` is the time of the collection log sync that
     * first saw the pet, not the time it dropped.
     */
    approximate: z.boolean(),
    /** What the pet came from, as the plugin guessed it. `null` when not known. */
    source: petSourceSchema.nullable(),
    /** KC of an `ACTIVITY` source when the pet dropped, from the account's own KC data. */
    killCount: positiveInt.nullable(),
    /** XP in a `SKILL` source when the pet dropped, from the account's own XP snapshots. */
    xp: nonNegativeInt.nullable(),
    /** `false` for a pet only seen in chat, until the collection log has it. */
    confirmed: z.boolean(),
    /**
     * `CHAT`: the time and source are from a `pet.drop` event. `CLOG`: the
     * pet is only known from the collection log.
     */
    origin: z.enum(PET_ORIGINS),
  })
  .check(({ value: pet, issues }) => {
    if (pet.approximate && pet.obtainedAt === null) {
      issue(issues, pet.approximate, ['approximate'], 'Only a set obtainedAt can be approximate');
    }
    if (pet.origin === 'CLOG' && !pet.confirmed) {
      issue(issues, pet.confirmed, ['confirmed'], 'A collection log pet is confirmed');
    }
    if (pet.origin === 'CHAT' && (pet.obtainedAt === null || pet.approximate)) {
      issue(issues, pet.obtainedAt, ['obtainedAt'], 'A chat pet has an exact obtainedAt');
    }
    if (pet.killCount !== null && pet.source?.type !== 'ACTIVITY') {
      issue(issues, pet.killCount, ['killCount'], 'Only an ACTIVITY source has killCount');
    }
    if (pet.xp !== null && pet.source?.type !== 'SKILL') {
      issue(issues, pet.xp, ['xp'], 'Only a SKILL source has xp');
    }
  });

export type Pet = z.infer<typeof petSchema>;

/** `GET /api/v1/accounts/:accountId/pets` (contract 1.27.0). `:accountId` may be `all`. */
export const petsResponseSchema = z.strictObject({
  /** Every pet of the account, or of every account for `all`. Not paginated. */
  pets: z.array(petSchema).check(({ value: pets, issues }) => {
    const seen = new Set<string>();
    pets.forEach((pet, index) => {
      const key = `${String(pet.accountId)}:${String(pet.itemId)}`;
      if (seen.has(key)) {
        issue(issues, pet, [index, 'itemId'], 'Each pet may appear only once per account');
      }
      seen.add(key);
      const previous = pets[index - 1];
      if (previous && comparePets(previous, pet) > 0) {
        issue(issues, pet, [index], 'Pets must be newest first, pets without a time last');
      }
    });
  }),
});

export type PetsResponse = z.infer<typeof petsResponseSchema>;

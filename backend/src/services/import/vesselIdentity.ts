import { validateImoNumber } from '../../utils/imoChecksum';
import { normalizeVesselName } from '../../utils/normalizeVesselName';

/**
 * Determines the stable identity to use for a vessel during Master import
 * (duplicate prevention) — IMO where plausible, otherwise normalized name.
 * Pure function: takes raw values, returns a lookup key description; the
 * caller does the actual DB query. Kept separate from the DB so the
 * decision logic is testable without Prisma.
 *
 * Reused (not just by Master import) anywhere a vessel identity needs to be
 * resolved — including manual vessel creation from a "New/Unknown" US
 * Calling List row, so duplicate protection works the same way everywhere
 * a vessel can come into existence.
 */
export interface VesselIdentity {
  imoNumber: string | null;
  imoPlausible: boolean;
  vesselNameNormalized: string;
  /** What to search by, in priority order — caller tries these against the DB in order. */
  lookupStrategy: 'IMO_THEN_NAME' | 'NAME_ONLY';
}

export function resolveVesselIdentity(rawVesselName: string, rawImoNumber: string | number | null | undefined): VesselIdentity {
  const imoStr = rawImoNumber === null || rawImoNumber === undefined ? null : String(rawImoNumber).trim();
  const { isPlausible } = validateImoNumber(imoStr);
  const hasImo = imoStr !== null && imoStr !== '';

  return {
    imoNumber: hasImo ? imoStr : null,
    imoPlausible: hasImo && isPlausible,
    vesselNameNormalized: normalizeVesselName(rawVesselName),
    // Even an implausible IMO isn't used for matching — only a genuinely
    // plausible one earns priority over the name. An implausible-but-present
    // IMO is still stored (never discarded), just not trusted for identity.
    lookupStrategy: hasImo && isPlausible ? 'IMO_THEN_NAME' : 'NAME_ONLY',
  };
}

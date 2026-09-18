import { prisma } from '../../db/prisma';
import { normalizeVesselName } from '../../utils/normalizeVesselName';

export async function markVesselDeparted(vesselName: string): Promise<void> {
  const vesselNameNormalized = normalizeVesselName(vesselName);
  await prisma.departedVesselMarker.upsert({
    where: { vesselNameNormalized },
    create: { vesselNameNormalized, vesselName },
    update: { vesselName, departedAt: new Date() },
  });
}

export async function clearVesselDeparted(vesselName: string): Promise<void> {
  const vesselNameNormalized = normalizeVesselName(vesselName);
  await prisma.departedVesselMarker.deleteMany({ where: { vesselNameNormalized } });
}

export async function getDepartedNormalizedNames(): Promise<Set<string>> {
  const markers = await prisma.departedVesselMarker.findMany({ select: { vesselNameNormalized: true } });
  return new Set(markers.map((m: { vesselNameNormalized: string }) => m.vesselNameNormalized));
}

export interface ReconcileDepartedMarkersSummary {
  totalMarkersChecked: number;
  cleared: Array<{ vesselName: string; foundOn: string[] }>;
}

/**
 * One-time cleanup for markers that went stale BEFORE the fix that made
 * every create/re-add path clear them automatically (see createEntry,
 * createTrackerEntry, importTrackerEntriesFromFile, and the VECS create
 * endpoint). Going forward, a marker can't go stale this way again — but
 * this reconciles whatever was already sitting stale in the database at
 * the moment that fix landed: a vessel could be marked Departed while
 * still actively present on ENOA/D List or US Calling (e.g. its ENOA was
 * sent by mistake, removed via "Departed", then added back once the
 * mistake was caught — before the auto-clear fix existed to catch that).
 *
 * For every current Departed marker, checks whether that vessel name is
 * currently present on ENOA/D List, US Calling, or still ACTIVE on VECS
 * List; if so, the marker is cleared, since active presence on any of
 * them is unambiguous evidence the vessel isn't actually departed.
 */
export async function reconcileDepartedMarkers(): Promise<ReconcileDepartedMarkersSummary> {
  const markers = await prisma.departedVesselMarker.findMany();
  const enoadNames = new Set(
    (await prisma.usCallingListEntry.findMany({ select: { vesselNameNormalized: true } })).map(
      (e: { vesselNameNormalized: string }) => e.vesselNameNormalized,
    ),
  );
  const usCallingNames = new Set(
    (await prisma.usCallingTrackerEntry.findMany({ select: { vesselNameNormalized: true } })).map(
      (e: { vesselNameNormalized: string }) => e.vesselNameNormalized,
    ),
  );
  const activeVecsNames = new Set(
    (await prisma.vessel.findMany({ where: { status: 'ACTIVE' }, select: { vesselNameNormalized: true } })).map(
      (v: { vesselNameNormalized: string }) => v.vesselNameNormalized,
    ),
  );

  const cleared: ReconcileDepartedMarkersSummary['cleared'] = [];
  for (const marker of markers) {
    const foundOn: string[] = [];
    if (enoadNames.has(marker.vesselNameNormalized)) foundOn.push('ENOA/D List');
    if (usCallingNames.has(marker.vesselNameNormalized)) foundOn.push('US Calling');
    if (activeVecsNames.has(marker.vesselNameNormalized)) foundOn.push('VECS List (Active)');
    if (foundOn.length > 0) {
      await prisma.departedVesselMarker.delete({ where: { id: marker.id } });
      cleared.push({ vesselName: marker.vesselName, foundOn });
    }
  }

  return { totalMarkersChecked: markers.length, cleared };
}

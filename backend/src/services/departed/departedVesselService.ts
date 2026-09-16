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

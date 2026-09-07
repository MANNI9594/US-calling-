/**
 * Groups extracted image anchors by their anchor row to decide, per row,
 * whether the association to "the vessel in this row" is trustworthy.
 *
 * This is pure logic (no DB, no I/O) specifically so it can be unit-tested
 * directly against the real reference workbook's anchor data without
 * needing a database — see tests/imageAssociationGrouping.test.ts, which
 * asserts the exact Phase 1 findings (33 clean rows, 17 images piled on
 * row 1) using the real file.
 *
 * Rule: if exactly one image anchors to a row, that's a clean, reviewable
 * candidate association (still NEEDS_REVIEW, never auto-CONFIRMED — see
 * EVIDENCE_MAPPING.md). If more than one image anchors to the same row,
 * NONE of them are associated automatically — the row's own vessel is not
 * privileged over the others sharing that pileup, because there is no
 * reliable signal for which (if any) of them actually belongs there. All
 * pileup images go to the Unassigned Evidence pool for Phase 4 OCR repair
 * or manual assignment.
 */

export interface ImageAnchorInput {
  imageId: number;
  anchorRow: number; // 0-indexed drawing anchor row, as read from the xlsx
  anchorCol: number;
}

export interface CleanAssociation {
  imageId: number;
  anchorRow: number;
  anchorCol: number;
  /** The 1-indexed Excel row this image is cleanly anchored to (anchorRow + 1). */
  excelRow: number;
}

export interface PileupImage {
  imageId: number;
  anchorRow: number;
  anchorCol: number;
  excelRow: number;
  /** How many images (including this one) share this exact anchor row. */
  pileupSize: number;
}

export interface GroupedImageAssociations {
  clean: CleanAssociation[];
  pileup: PileupImage[];
}

export function groupImageAnchorsByRow(images: ImageAnchorInput[]): GroupedImageAssociations {
  const byRow = new Map<number, ImageAnchorInput[]>();
  for (const img of images) {
    const bucket = byRow.get(img.anchorRow) ?? [];
    bucket.push(img);
    byRow.set(img.anchorRow, bucket);
  }

  const clean: CleanAssociation[] = [];
  const pileup: PileupImage[] = [];

  for (const [anchorRow, group] of byRow.entries()) {
    const excelRow = anchorRow + 1; // anchorRow is 0-indexed (anchorRow 0 = Excel row 1 = header; anchorRow 1 = Excel row 2, the first data row)
    if (group.length === 1) {
      const img = group[0];
      clean.push({ imageId: img.imageId, anchorRow: img.anchorRow, anchorCol: img.anchorCol, excelRow });
    } else {
      for (const img of group) {
        pileup.push({
          imageId: img.imageId,
          anchorRow: img.anchorRow,
          anchorCol: img.anchorCol,
          excelRow,
          pileupSize: group.length,
        });
      }
    }
  }

  return { clean, pileup };
}

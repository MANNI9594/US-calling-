/**
 * IMO Number validation.
 *
 * A real IMO ship identification number is exactly 7 digits. The 7th digit
 * is a check digit: multiply digits 1-6 by weights 7,6,5,4,3,2 and the sum's
 * last digit must equal digit 7.
 *
 * We NEVER reject or discard a stored IMO number based on this — the source
 * Master workbook contains values (e.g. "1023920") that are numeric-looking
 * but fail this check, and the user still wants them retained as supplied.
 * This function only tells the caller whether to raise a DataQualityIssue.
 */
export interface ImoValidationResult {
  isPlausible: boolean;
  reason?: string;
}

export function validateImoNumber(rawValue: string | null | undefined): ImoValidationResult {
  if (rawValue === null || rawValue === undefined || rawValue.trim() === '') {
    return { isPlausible: true }; // absent is not implausible, just missing — handled separately
  }

  const trimmed = rawValue.trim();

  if (!/^\d{7}$/.test(trimmed)) {
    return { isPlausible: false, reason: 'IMO number must be exactly 7 digits' };
  }

  const digits = trimmed.split('').map(Number);
  const weights = [7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0);
  const expectedCheckDigit = sum % 10;
  const actualCheckDigit = digits[6];

  if (expectedCheckDigit !== actualCheckDigit) {
    return {
      isPlausible: false,
      reason: `Check digit mismatch: expected ${expectedCheckDigit}, got ${actualCheckDigit}`,
    };
  }

  return { isPlausible: true };
}

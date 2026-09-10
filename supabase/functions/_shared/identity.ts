export function normalizeBrazilianPhone(value: unknown): string {
  let digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  return digits;
}

export function storedPhoneMatches(storedPhone: unknown, suppliedPhone: unknown): boolean {
  const stored = normalizeBrazilianPhone(storedPhone);
  const supplied = normalizeBrazilianPhone(suppliedPhone);
  return stored.length > 0 && supplied.length > 0 && stored === supplied;
}

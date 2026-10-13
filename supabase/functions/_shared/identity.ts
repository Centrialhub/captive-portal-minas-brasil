/** Pure validation shared by the browser and Edge Function. No I/O or secrets. */
export const VALID_BR_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export function normalizeCPF(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9.\s-]*$/.test(value)) return "";
  return value.replace(/\D/g, "");
}

export function normalizeBrazilianPhone(value: unknown): string {
  if (typeof value !== "string" || !/^\s*\+?[0-9()\s.-]*$/.test(value)) return "";
  const raw = value.trim();
  const digits = raw.replace(/\D/g, "");
  const international = digits.startsWith("55") && (digits.length === 12 || digits.length === 13) && !raw.startsWith("(");
  if (international) return digits.slice(2);
  return raw.startsWith("+") ? "+" + digits : digits;
}

export function isValidBrazilianPhone(value: unknown): boolean {
  const digits = normalizeBrazilianPhone(value);
  if (!/^\d{10,11}$/.test(digits) || !VALID_BR_DDD.has(Number(digits.slice(0, 2)))) return false;
  return digits.length === 11 ? digits[2] === "9" : /^[2-5]/.test(digits[2]);
}

export function isValidCPF(value: unknown): boolean {
  const digits = normalizeCPF(value);
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(digits[i]) * (size + 1 - i);
    const remainder = sum % 11;
    if (Number(digits[size]) !== (remainder < 2 ? 0 : 11 - remainder)) return false;
  }
  return true;
}

/** A friction signal, not proof that a structurally valid line is fictitious. */
export function needsPhoneConfirmation(value: unknown): boolean {
  const phone = normalizeBrazilianPhone(value);
  if (!isValidBrazilianPhone(phone)) return false;
  const subscriber = phone.slice(2);
  return /^(\d)\1+$/.test(subscriber) || (phone.length === 11 && /^(\d)\1{7}$/.test(subscriber.slice(1)));
}

export function storedPhoneMatches(storedPhone: unknown, suppliedPhone: unknown): boolean {
  const stored = normalizeBrazilianPhone(storedPhone);
  const supplied = normalizeBrazilianPhone(suppliedPhone);
  return stored.length > 0 && supplied.length > 0 && stored === supplied;
}

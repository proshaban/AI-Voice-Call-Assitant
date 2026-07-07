/**
 * Normalizes any phone input into E.164 format.
 *
 * - Already E.164 (starts with "+")            -> returned as-is (digits only after +)
 * - Bare national number (e.g. "9876543210")    -> prefixed with DEFAULT_COUNTRY_CODE
 *
 * DEFAULT_COUNTRY_CODE defaults to "+91" (India) but is configurable via env
 * since this app can call "any number", not just Indian ones.
 */
export function normalizePhone(raw: string): string {
  if (!raw) throw new Error("Phone number is required");

  const trimmed = raw.trim();

  if (trimmed.startsWith("+")) {
    return "+" + trimmed.slice(1).replace(/\D/g, "");
  }

  const digitsOnly = trimmed.replace(/\D/g, "");
  const defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || "+91";

  return `${defaultCountryCode}${digitsOnly}`;
}

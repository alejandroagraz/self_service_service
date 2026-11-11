/** Helpers de parseo de query string compartidos por los controllers. */
export const toPositiveInt = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

/** Cadena no vacía (recortada) o `undefined`. */
export const toOptionalString = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

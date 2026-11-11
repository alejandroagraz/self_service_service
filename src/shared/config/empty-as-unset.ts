/**
 * Una variable de entorno presente con valor `""` se trata como **no definida**.
 *
 * Compose pasa a cada servicio sus variables como `VAR: ${TIME_VAR:-}`, para que el `.env`
 * siga siendo el único sitio de ajuste sin duplicar en compose los valores por defecto. Una
 * variable que el `.env` no define llega entonces como `""`, no como ausente. Sin esta
 * normalización:
 *
 * - una variable con valor por defecto **no** lo recibiría: envalid solo aplica el `default`
 *   cuando la clave es `undefined`, y `""` pasaría al validador (`port("")` falla, `str("")`
 *   devuelve una cadena vacía);
 * - una obligatoria fallaría como "inválida" en lugar de como "falta", que es lo que es.
 *
 * Solo `""` exacto: `"   "` sí llega al validador, que es quien debe rechazarla.
 */
export const withEmptyAsUnset = (source: NodeJS.ProcessEnv): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value !== "") {
      result[key] = value;
    }
  }
  return result;
};

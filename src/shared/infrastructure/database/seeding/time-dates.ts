/**
 * Utilidades de fecha para los seeders de `time`. Los fichajes/turnos se generan RELATIVOS a la
 * fecha de ejecución (para que el portal muestre datos recientes); los ids derivan de la fecha, así
 * que re-ejecutar el mismo día es idempotente y re-ejecutar otro día solo AÑADE el día nuevo.
 */
export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Lunes (UTC) de la semana que contiene `d`. */
export function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0=domingo … 6=sábado
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}

/** Los últimos `count` días hábiles (lun–vie) hasta `from` inclusive, en orden ascendente. */
export function lastBusinessDays(from: Date, count: number): Date[] {
  const out: Date[] = [];
  let cur = new Date(from);
  while (out.length < count) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push(new Date(cur));
    }
    cur = addDays(cur, -1);
  }
  return out.reverse();
}

/** `timestamptz` para una fecha civil + hora "HH:MM" (UTC-4 Venezuela → se guarda como UTC). */
export function atTime(isoDate: string, hhmm: string): Date {
  return new Date(`${isoDate}T${hhmm}:00-04:00`);
}

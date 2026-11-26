/**
 * Utilidades de fecha para los seeders de `time`. Los fichajes/turnos se generan RELATIVOS a la
 * fecha de ejecución (para que el portal muestre datos recientes); los ids derivan de la fecha, así
 * que re-ejecutar el mismo día es idempotente y re-ejecutar otro día solo AÑADE el día nuevo.
 *
 * "Hoy" es SIEMPRE el día civil de America/Caracas (UTC-4, C9), no el día UTC: entre las 20:00 y las
 * 24:00 de Caracas el día UTC ya es mañana. Las fechas civiles se representan como `Date` a las 00:00
 * UTC de ese día, de modo que `toISODate`/`addDays`/`getUTCDay` operan sobre el día civil sin zona.
 * (`caracasToday`/`hasHappened` son copia de los de people: no se importa código entre servicios; el
 * día civil sale de `vetDateOf`, la fuente única de self_service.)
 */
import { vetDateOf } from "../../../../modules/self-portal/domain/services/operational-day";

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Día civil de Caracas en el instante `now`, como `YYYY-MM-DD`. */
export function caracasTodayISO(now: Date = new Date()): string {
  return vetDateOf(now);
}

/** Día civil de Caracas en el instante `now`, como `Date` a las 00:00 UTC de ese día. */
export function caracasToday(now: Date = new Date()): Date {
  return new Date(`${caracasTodayISO(now)}T00:00:00.000Z`);
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Lunes de la semana (civil) que contiene `d`. */
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

/** ¿El instante `isoDate` a las `hhmm` (Caracas) ya ocurrió en `now`? Evita sembrar el futuro. */
export function hasHappened(isoDate: string, hhmm: string, now: Date): boolean {
  return atTime(isoDate, hhmm).getTime() <= now.getTime();
}

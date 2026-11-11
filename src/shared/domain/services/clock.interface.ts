/**
 * Puerto de reloj. El dominio no llama `new Date()` ni conoce `dayjs`: pide la hora a
 * través de este puerto, implementado en infraestructura con dayjs (UTC).
 */
export interface IClock {
  now(): Date;
  addSeconds(base: Date, seconds: number): Date;
  isBefore(a: Date, b: Date): boolean;
}

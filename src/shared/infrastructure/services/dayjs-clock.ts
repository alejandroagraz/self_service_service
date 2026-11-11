/**
 * Implementación del puerto `IClock` con dayjs en UTC. Toda la persistencia usa
 * `timestamptz`, así que el servicio razona siempre en UTC y deja la conversión a hora de
 * Venezuela al frontend.
 */
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { injectable } from "tsyringe";

import type { IClock } from "../../domain/services/clock.interface";

dayjs.extend(utc);

@injectable()
export class DayjsClock implements IClock {
  now(): Date {
    return dayjs.utc().toDate();
  }

  addSeconds(base: Date, seconds: number): Date {
    return dayjs.utc(base).add(seconds, "second").toDate();
  }

  isBefore(a: Date, b: Date): boolean {
    return dayjs.utc(a).isBefore(dayjs.utc(b));
  }
}

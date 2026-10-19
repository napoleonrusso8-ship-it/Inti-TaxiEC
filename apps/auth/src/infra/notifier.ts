import { Logger } from '@nestjs/common';
import { maskEmail, maskPhone } from '@intitaxi/crypto';

export interface SmsSender {
  send(toE164: string, message: string): Promise<void>;
}

export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

/**
 * Solo desarrollo local: muestra el mensaje en la consola para poder probar sin proveedor.
 * La configuración impide usarlo en producción. Ojo: el mensaje contiene el OTP.
 */
export class ConsoleSmsSender implements SmsSender {
  readonly #log = new Logger('SMS(dev)');
  async send(to: string, message: string) {
    this.#log.warn(`[DEV] SMS a ${maskPhone(to)}: ${message}`);
  }
}

export class ConsoleEmailSender implements EmailSender {
  readonly #log = new Logger('Email(dev)');
  async send(to: string, subject: string, text: string) {
    this.#log.warn(`[DEV] Correo a ${maskEmail(to)} — ${subject}: ${text}`);
  }
}

/** Para pruebas: guarda los mensajes en memoria. */
export class CapturingSender implements SmsSender, EmailSender {
  readonly sent: { to: string; subject?: string; text: string }[] = [];
  async send(to: string, a: string, b?: string) {
    this.sent.push(b === undefined ? { to, text: a } : { to, subject: a, text: b });
  }
  lastTo(to: string) {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

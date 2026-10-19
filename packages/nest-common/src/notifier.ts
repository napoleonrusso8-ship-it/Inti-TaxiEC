import { Logger } from '@nestjs/common';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { maskEmail, maskPhone } from '@intitaxi/crypto';
import type { Redis } from 'ioredis';

export interface SmsSender {
  send(toE164: string, message: string): Promise<void>;
}

export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Infobip SMS API (POST /sms/2/text/advanced). La API key vive en Secrets Manager. */
export class InfobipSmsSender implements SmsSender {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly sender: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(to: string, text: string) {
    const res = await this.fetchFn(new URL('/sms/2/text/advanced', this.baseUrl), {
      method: 'POST',
      headers: { Authorization: `App ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ messages: [{ destinations: [{ to: to.replace('+', '') }], from: this.sender, text }] }),
      signal: AbortSignal.timeout(5000),
    });
    // Nunca se registra el cuerpo (contiene el OTP) ni el número completo.
    if (!res.ok) throw new Error(`Infobip respondió ${res.status} para ${maskPhone(to)}`);
  }
}

/** Amazon SES v2. Requiere dominio verificado con DKIM, SPF y DMARC. */
export class SesEmailSender implements EmailSender {
  constructor(
    private readonly client: Pick<SESv2Client, 'send'>,
    private readonly from: string,
    private readonly configurationSet?: string,
  ) {}

  static create(region: string, from: string, configurationSet?: string) {
    return new SesEmailSender(new SESv2Client({ region }), from, configurationSet);
  }

  async send(to: string, subject: string, text: string) {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: this.configurationSet,
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
      }),
    );
  }
}

export interface DevboxMessage {
  channel: 'sms' | 'email';
  to: string;
  subject?: string;
  text: string;
  at: string;
}

/**
 * Bandeja de desarrollo: guarda los mensajes en Redis para que el simulador los muestre.
 * Prohibida en producción por la validación de configuración.
 */
export class DevboxSender implements SmsSender, EmailSender {
  static readonly KEY = 'devbox:messages';
  constructor(
    private readonly redis: Redis,
    private readonly channel: 'sms' | 'email',
  ) {}

  async send(to: string, a: string, b?: string) {
    const msg: DevboxMessage = { channel: this.channel, to, at: new Date().toISOString(), ...(b === undefined ? { text: a } : { subject: a, text: b }) };
    await this.redis.multi().lpush(DevboxSender.KEY, JSON.stringify(msg)).ltrim(DevboxSender.KEY, 0, 499).exec();
  }
}

/** Solo desarrollo local: muestra el mensaje en la consola. Ojo: el mensaje puede contener el OTP. */
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

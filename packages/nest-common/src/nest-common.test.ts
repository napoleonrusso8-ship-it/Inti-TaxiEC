import { describe, expect, it, vi } from 'vitest';
import { checkInfraConfig, infraEnvSchema } from './config.js';
import { DevboxSender, InfobipSmsSender, SesEmailSender } from './notifier.js';

describe('InfobipSmsSender', () => {
  it('envía con la API key en la cabecera y sin el "+"', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    await new InfobipSmsSender('https://abc.api.infobip.com', 'KEY', 'IntiTaxi', fetchFn as never).send('+593991234567', 'hola');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://abc.api.infobip.com/sms/2/text/advanced');
    expect((init.headers as Record<string, string>).Authorization).toBe('App KEY');
    expect(JSON.parse(init.body as string).messages[0]).toEqual({ destinations: [{ to: '593991234567' }], from: 'IntiTaxi', text: 'hola' });
  });

  it('no incluye el texto (OTP) ni el número completo en el error', async () => {
    const fetchFn = vi.fn(async () => new Response('err', { status: 500 }));
    const err = await new InfobipSmsSender('https://x.test', 'KEY', 'S', fetchFn as never).send('+593991234567', 'código 123456').catch((e: Error) => e);
    expect((err as Error).message).not.toContain('123456');
    expect((err as Error).message).not.toContain('991234567');
  });
});

describe('SesEmailSender', () => {
  it('construye el correo en UTF-8', async () => {
    const send = vi.fn(async () => ({}));
    await new SesEmailSender({ send } as never, 'no-reply@intitaxi.ec').send('a@b.ec', 'Asunto', 'Cuerpo');
    const input = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input;
    expect(input).toMatchObject({ FromEmailAddress: 'no-reply@intitaxi.ec', Destination: { ToAddresses: ['a@b.ec'] } });
  });
});

describe('DevboxSender', () => {
  it('guarda el mensaje en la lista de Redis', async () => {
    const calls: unknown[][] = [];
    const multi = { lpush: (...a: unknown[]) => (calls.push(['lpush', ...a]), multi), ltrim: (...a: unknown[]) => (calls.push(['ltrim', ...a]), multi), exec: async () => [] };
    await new DevboxSender({ multi: () => multi } as never, 'sms').send('+593991234567', 'hola');
    expect(calls[0]![1]).toBe(DevboxSender.KEY);
    expect(JSON.parse(calls[0]![2] as string)).toMatchObject({ channel: 'sms', to: '+593991234567', text: 'hola' });
  });
});

describe('checkInfraConfig', () => {
  const base = { PUBLIC_BASE_URL: 'https://x.ec', DATABASE_URL: 'p', REDIS_URL: 'r', BLIND_INDEX_KEY: Buffer.alloc(32).toString('base64') };
  it('rechaza devbox/console en producción', () => {
    const issues: string[] = [];
    checkInfraConfig(infraEnvSchema.parse({ ...base, NODE_ENV: 'production', SMS_PROVIDER: 'devbox', KEY_PROVIDER: 'kms', KMS_KEY_ID: 'k' }), (p) => issues.push(p));
    expect(issues).toEqual(expect.arrayContaining(['SMS_PROVIDER', 'EMAIL_PROVIDER', 'DATABASE_SSL_CA', 'REDIS_TLS']));
  });
  it('exige credenciales de Infobip cuando se elige', () => {
    const issues: string[] = [];
    checkInfraConfig(infraEnvSchema.parse({ ...base, SMS_PROVIDER: 'infobip', LOCAL_MASTER_KEY: base.BLIND_INDEX_KEY }), (p) => issues.push(p));
    expect(issues).toContain('INFOBIP_API_KEY');
  });
  it('el token de acceso dura 10 minutos por defecto', () => {
    expect(infraEnvSchema.parse(base).ACCESS_TOKEN_TTL_SECONDS).toBe(600);
  });
});

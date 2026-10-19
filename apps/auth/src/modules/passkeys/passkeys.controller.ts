import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AuditService, AppError, parseInput, AccessTokenGuard, AttestationGuard, Auth, DpopProofGuard, OneTimeStore, type AppRequest, type EmailSender } from '@intitaxi/nest-common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { ACR_PHR, assertRecentMfa, type AuthContext } from '@intitaxi/auth-verifier';
import { maskPhone, randomToken } from '@intitaxi/crypto';
import type { Pool } from '@intitaxi/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { CONFIG, EMAIL_SENDER, PG_POOL } from '../../tokens.js';
import { UsersRepository } from '../account/users.repository.js';
import { MOBILE_CLIENTS, TokenService } from '../tokens/token.service.js';

const CHALLENGE_TTL = 300;
const PASSKEY_AMR = ['hwk', 'user'];

interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  sign_count: string;
  transports: AuthenticatorTransportFuture[];
  user_status: string;
}

const WebAuthnResponse = z.object({ id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal('public-key') }).passthrough();

/**
 * Passkeys (WebAuthn / FIDO2): método preferente de inicio de sesión y de step-up (MFA).
 * Se exige verificación de usuario (biometría o PIN del dispositivo) y solo se guardan claves públicas.
 */
@Controller('v1/auth')
export class PasskeysController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(OneTimeStore) private readonly once: OneTimeStore,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ---------- Registro ----------

  @Post('passkeys/registration/options')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard, AttestationGuard)
  async registrationOptions(@Auth() auth: AuthContext) {
    const user = await this.users.findById(auth.userId);
    if (!user || user.status !== 'active') throw new AppError(403, 'account_unavailable');
    const existing = await this.#userCredentials(auth.userId);
    await this.#assertCanAddPasskey(auth, existing.length, user.sensitive_ops_locked_until);
    const options = await generateRegistrationOptions({
      rpName: this.config.WEBAUTHN_RP_NAME,
      rpID: this.config.WEBAUTHN_RP_ID,
      userID: Buffer.from(auth.userId, 'utf8'),
      userName: maskPhone(await this.users.phoneOf(user)),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
    });
    await this.once.put(`webauthn:reg:${auth.sessionId}`, { challenge: options.challenge }, CHALLENGE_TTL);
    return options;
  }

  @Post('passkeys/registration/verify')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard, AttestationGuard)
  async registrationVerify(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const response = parseInput(WebAuthnResponse, body) as unknown as RegistrationResponseJSON;
    const stored = await this.once.take<{ challenge: string }>(`webauthn:reg:${auth.sessionId}`);
    if (!stored) throw new AppError(400, 'invalid_challenge', 'Reto expirado');
    const user = await this.users.findById(auth.userId);
    const existing = await this.#userCredentials(auth.userId);
    await this.#assertCanAddPasskey(auth, existing.length, user?.sensitive_ops_locked_until ?? null);

    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.config.WEBAUTHN_ORIGINS,
      expectedRPID: this.config.WEBAUTHN_RP_ID,
      requireUserVerification: true,
    }).catch(() => null);
    if (!v?.verified || !v.registrationInfo) {
      await this.audit.record({ action: 'passkey.register', resourceType: 'user', resourceId: auth.userId, outcome: 'denied' }, req);
      throw new AppError(400, 'passkey_invalid', 'No se pudo registrar la passkey');
    }
    const { credential, aaguid } = v.registrationInfo;
    const id = randomUUID();
    try {
      await this.pool.query(
        `INSERT INTO identity.credentials (id, user_id, type, credential_id, public_key, sign_count, transports, aaguid)
         VALUES ($1, $2, 'passkey', $3, $4, $5, $6, $7)`,
        [id, auth.userId, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], aaguid],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'passkey_exists', 'La passkey ya está registrada');
      throw e;
    }
    await this.audit.record({ action: 'passkey.register', resourceType: 'credential', resourceId: id, metadata: { aaguid } }, req);
    const to = user?.email_verified_at ? await this.users.emailOf(user) : null;
    if (to) await this.email.send(to, 'Nueva passkey en Inti Taxi', 'Se agregó una passkey a tu cuenta. Si no fuiste tú, contacta a soporte.');
    return { id };
  }

  // ---------- Inicio de sesión ----------

  @Post('passkeys/authentication/options')
  @HttpCode(200)
  @UseGuards(DpopProofGuard, AttestationGuard)
  async authenticationOptions(@Req() req: AppRequest) {
    const options = await generateAuthenticationOptions({ rpID: this.config.WEBAUTHN_RP_ID, userVerification: 'required' });
    const flowId = randomToken(16);
    await this.once.put(`webauthn:auth:${flowId}`, { challenge: options.challenge, jkt: req.device!.jkt }, CHALLENGE_TTL);
    return { flowId, options };
  }

  @Post('passkeys/authentication/verify')
  @HttpCode(200)
  @UseGuards(DpopProofGuard, AttestationGuard)
  async authenticationVerify(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parseInput(
      z.object({
        flowId: z.string().max(64),
        response: WebAuthnResponse,
        codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        codeChallengeMethod: z.literal('S256'),
      }),
      body,
    );
    const stored = await this.once.take<{ challenge: string; jkt: string }>(`webauthn:auth:${input.flowId}`);
    if (!stored || stored.jkt !== req.device!.jkt) throw new AppError(400, 'invalid_challenge', 'Reto expirado');
    const cred = await this.#verifyAssertion(input.response as unknown as AuthenticationResponseJSON, stored.challenge, req);
    const code = await this.tokens.issueAuthCode({
      allowedClients: MOBILE_CLIENTS,
      userId: cred.user_id,
      deviceId: req.device!.deviceId,
      jkt: req.device!.jkt,
      codeChallenge: input.codeChallenge,
      acr: ACR_PHR,
      amr: PASSKEY_AMR,
      authTime: Math.floor(Date.now() / 1000),
    });
    return { code };
  }

  // ---------- Step-up (MFA para operaciones sensibles) ----------

  @Post('step-up/passkey/options')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async stepUpOptions(@Auth() auth: AuthContext) {
    const creds = await this.#userCredentials(auth.userId);
    if (creds.length === 0) throw new AppError(409, 'no_passkey', 'Registra una passkey para continuar');
    const options = await generateAuthenticationOptions({
      rpID: this.config.WEBAUTHN_RP_ID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports })),
    });
    await this.once.put(`webauthn:stepup:${auth.sessionId}`, { challenge: options.challenge }, CHALLENGE_TTL);
    return options;
  }

  @Post('step-up/passkey/verify')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async stepUpVerify(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const response = parseInput(WebAuthnResponse, body) as unknown as AuthenticationResponseJSON;
    const stored = await this.once.take<{ challenge: string }>(`webauthn:stepup:${auth.sessionId}`);
    if (!stored) throw new AppError(400, 'invalid_challenge', 'Reto expirado');
    const cred = await this.#verifyAssertion(response, stored.challenge, req);
    if (cred.user_id !== auth.userId) {
      await this.audit.record({ action: 'stepup.passkey', resourceType: 'session', resourceId: auth.sessionId, outcome: 'denied' }, req);
      throw new AppError(400, 'passkey_invalid', 'No se pudo verificar la passkey');
    }
    // Una passkey registrada antes del bloqueo prueba que no es un atacante con la SIM: se levanta el bloqueo anti SIM swap.
    const lifted = await this.pool.query(
      `UPDATE identity.users SET sensitive_ops_locked_until = NULL, updated_at = now() WHERE id = $1 AND sensitive_ops_locked_until > now()`,
      [auth.userId],
    );
    const tokens = await this.tokens.stepUp(auth.sessionId, auth.userId, PASSKEY_AMR, ACR_PHR);
    await this.audit.record({ action: 'stepup.passkey', resourceType: 'session', resourceId: auth.sessionId, metadata: { lock_lifted: (lifted.rowCount ?? 0) > 0 } }, req);
    return tokens;
  }

  // ---------- Internos ----------

  async #verifyAssertion(response: AuthenticationResponseJSON, challenge: string, req: AppRequest): Promise<CredentialRow> {
    const { rows } = await this.pool.query<CredentialRow>(
      `SELECT c.*, u.status AS user_status FROM identity.credentials c JOIN identity.users u ON u.id = c.user_id
       WHERE c.credential_id = $1 AND c.type = 'passkey' AND c.revoked_at IS NULL`,
      [response.id],
    );
    const cred = rows[0];
    const fail = async () => {
      await this.audit.record({ action: 'passkey.authenticate', resourceType: 'credential', resourceId: cred?.id ?? null, outcome: 'denied', actorUserId: cred?.user_id ?? null }, req);
      return new AppError(400, 'passkey_invalid', 'No se pudo verificar la passkey');
    };
    if (!cred || cred.user_status !== 'active') throw await fail();
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.WEBAUTHN_ORIGINS,
      expectedRPID: this.config.WEBAUTHN_RP_ID,
      requireUserVerification: true,
      credential: { id: cred.credential_id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.sign_count), transports: cred.transports },
    }).catch(() => null);
    if (!v?.verified) throw await fail();
    // Contador: si retrocede, la librería ya rechaza (posible clon del autenticador).
    await this.pool.query('UPDATE identity.credentials SET sign_count = $2, last_used_at = now() WHERE id = $1', [cred.id, v.authenticationInfo.newCounter]);
    await this.audit.record({ action: 'passkey.authenticate', resourceType: 'credential', resourceId: cred.id, actorUserId: cred.user_id }, req);
    return cred;
  }

  async #userCredentials(userId: string) {
    const { rows } = await this.pool.query<{ credential_id: string; transports: AuthenticatorTransportFuture[] }>(
      `SELECT credential_id, transports FROM identity.credentials WHERE user_id = $1 AND type = 'passkey' AND revoked_at IS NULL`,
      [userId],
    );
    return rows;
  }

  /**
   * Evita que un atacante con el número (SIM swap) registre SU passkey y la use luego como MFA:
   * - si ya hay passkeys, añadir otra exige MFA reciente con una existente;
   * - la primera passkey no se puede registrar mientras rija el bloqueo por nuevo dispositivo / cambio de número.
   */
  async #assertCanAddPasskey(auth: AuthContext, existing: number, lockedUntil: Date | null) {
    if (existing > 0) {
      assertRecentMfa(auth);
      return;
    }
    if (lockedUntil && lockedUntil > new Date()) {
      throw new AppError(403, 'sensitive_ops_locked', 'Por seguridad, podrás agregar una passkey cuando termine el periodo de protección de tu cuenta');
    }
  }
}

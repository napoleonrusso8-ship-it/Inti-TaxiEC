import { Inject, Injectable } from '@nestjs/common';
import { ACR_BASIC, ACR_MFA } from '@intitaxi/auth-verifier';
import { constantTimeEqual, randomToken, sha256, sha256Base64Url } from '@intitaxi/crypto';
import { withTransaction, type Pool, type PoolClient } from '@intitaxi/db';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../common/audit.service.js';
import { OAuthError } from '../../common/errors.js';
import type { AppRequest } from '../../common/request.js';
import { SigningKeys } from '../../common/signing-keys.js';
import type { AppConfig } from '../../config.js';
import { OneTimeStore, RedisSessionRevocation } from '../../infra/redis-stores.js';
import { CONFIG, PG_POOL } from '../../tokens.js';

export interface AuthCodeGrant {
  userId: string;
  deviceId: string;
  jkt: string;
  codeChallenge: string;
  acr: string;
  amr: string[];
  authTime: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'DPoP';
  expires_in: number;
  refresh_token: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string;
  client_id: string;
  dpop_jkt: string;
  acr: string;
  amr: string[];
  auth_time: Date;
  expires_at: Date;
  revoked_at: Date | null;
  user_status: string;
}

const AUTH_CODE_TTL = 60;

@Injectable()
export class TokenService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SigningKeys) private readonly keys: SigningKeys,
    @Inject(OneTimeStore) private readonly once: OneTimeStore,
    @Inject(RedisSessionRevocation) private readonly revocation: RedisSessionRevocation,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Código de autorización de un solo uso (60 s), ligado a PKCE y a la clave DPoP del dispositivo. */
  async issueAuthCode(grant: AuthCodeGrant): Promise<string> {
    const code = randomToken(32);
    await this.once.put(`authcode:${sha256Base64Url(code)}`, grant, AUTH_CODE_TTL);
    return code;
  }

  async exchangeCode(input: { code: string; codeVerifier: string; clientId: string; jkt: string }, req: AppRequest): Promise<TokenResponse> {
    this.#assertClient(input.clientId);
    const grant = await this.once.take<AuthCodeGrant>(`authcode:${sha256Base64Url(input.code)}`);
    if (!grant) throw new OAuthError('invalid_grant');
    const challenge = Buffer.from(sha256Base64Url(input.codeVerifier));
    if (!constantTimeEqual(challenge, Buffer.from(grant.codeChallenge)) || grant.jkt !== input.jkt) {
      await this.audit.recordSafe({ action: 'token.code_exchange', resourceType: 'user', resourceId: grant.userId, outcome: 'denied', actorUserId: grant.userId }, req);
      throw new OAuthError('invalid_grant');
    }

    const refreshToken = randomToken(32);
    const sessionId = randomUUID();
    const session = await withTransaction(this.pool, async (c) => {
      const u = await c.query<{ status: string }>('SELECT status FROM identity.users WHERE id = $1 FOR SHARE', [grant.userId]);
      if (u.rows[0]?.status !== 'active') throw new OAuthError('invalid_grant');
      await c.query('UPDATE identity.devices SET user_id = $1, last_seen_at = now() WHERE id = $2', [grant.userId, grant.deviceId]);
      const { rows } = await c.query<SessionRow>(
        `INSERT INTO identity.sessions (id, user_id, device_id, client_id, dpop_jkt, current_token_hash, acr, amr, auth_time, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), now() + make_interval(days => $10))
         RETURNING *, 'active' AS user_status`,
        [sessionId, grant.userId, grant.deviceId, input.clientId, grant.jkt, sha256(refreshToken), grant.acr, grant.amr, grant.authTime, this.config.REFRESH_TOKEN_TTL_DAYS],
      );
      await this.audit.record({ action: 'session.create', resourceType: 'session', resourceId: sessionId, actorUserId: grant.userId, actorDeviceId: grant.deviceId, metadata: { acr: grant.acr, amr: grant.amr.join(' ') } }, req, c);
      return rows[0]!;
    });
    return { access_token: await this.#accessToken(session), token_type: 'DPoP', expires_in: this.config.ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken };
  }

  /**
   * Rotación de refresh token con detección de reutilización:
   * - token vigente + misma clave DPoP → se rota;
   * - token ya rotado (en historial) o vigente pero presentado con otra clave DPoP → robo: se revoca la sesión entera.
   */
  async refresh(input: { refreshToken: string; clientId: string; jkt: string }, req: AppRequest): Promise<TokenResponse> {
    this.#assertClient(input.clientId);
    const oldHash = sha256(input.refreshToken);
    const newToken = randomToken(32);

    const outcome = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<SessionRow>(
        `SELECT s.*, u.status AS user_status FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id
         WHERE s.current_token_hash = $1 FOR UPDATE OF s`,
        [oldHash],
      );
      const s = rows[0];
      if (!s) {
        const reused = await c.query<{ session_id: string }>('SELECT session_id FROM identity.refresh_token_history WHERE token_hash = $1', [oldHash]);
        const sid = reused.rows[0]?.session_id;
        if (sid) {
          await this.#revoke(c, sid, 'refresh_token_reuse');
          await this.audit.record({ action: 'session.refresh_reuse_detected', resourceType: 'session', resourceId: sid, outcome: 'denied' }, req, c);
        }
        return { kind: 'invalid' as const, revokedSid: sid };
      }
      if (s.revoked_at || s.expires_at < new Date() || s.client_id !== input.clientId || s.user_status !== 'active') {
        return { kind: 'invalid' as const };
      }
      if (s.dpop_jkt !== input.jkt) {
        await this.#revoke(c, s.id, 'refresh_token_wrong_key');
        await this.audit.record({ action: 'session.refresh_wrong_key', resourceType: 'session', resourceId: s.id, actorUserId: s.user_id, outcome: 'denied' }, req, c);
        return { kind: 'invalid' as const, revokedSid: s.id };
      }
      await c.query('INSERT INTO identity.refresh_token_history (token_hash, session_id) VALUES ($1, $2)', [oldHash, s.id]);
      await c.query(
        'UPDATE identity.sessions SET current_token_hash = $1, generation = generation + 1, last_rotated_at = now() WHERE id = $2',
        [sha256(newToken), s.id],
      );
      return { kind: 'ok' as const, session: s };
    });

    if (outcome.kind === 'invalid') {
      if (outcome.revokedSid) await this.revocation.revoke(outcome.revokedSid);
      throw new OAuthError('invalid_grant');
    }
    return {
      access_token: await this.#accessToken(outcome.session),
      token_type: 'DPoP',
      expires_in: this.config.ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: newToken,
    };
  }

  /** Eleva la sesión a MFA tras un step-up y devuelve un token de acceso nuevo con acr=mfa. */
  async stepUp(sessionId: string, userId: string, amr: string[]): Promise<{ access_token: string; token_type: 'DPoP'; expires_in: number }> {
    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE identity.sessions s SET acr = $3, amr = $4, auth_time = now()
       FROM identity.users u
       WHERE s.id = $1 AND s.user_id = $2 AND u.id = s.user_id AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'
       RETURNING s.*, u.status AS user_status`,
      [sessionId, userId, ACR_MFA, amr],
    );
    if (!rows[0]) throw new OAuthError('invalid_grant');
    return { access_token: await this.#accessToken(rows[0]), token_type: 'DPoP', expires_in: this.config.ACCESS_TOKEN_TTL_SECONDS };
  }

  /** Revoca por refresh token (RFC 7009). Responde igual exista o no el token. */
  async revokeByRefreshToken(refreshToken: string, clientId: string): Promise<void> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE identity.sessions SET revoked_at = now(), revoke_reason = 'client_revoke'
       WHERE current_token_hash = $1 AND client_id = $2 AND revoked_at IS NULL RETURNING id`,
      [sha256(refreshToken), clientId],
    );
    if (rows[0]) await this.revocation.revoke(rows[0].id);
  }

  /** Revoca una sesión del usuario. Devuelve false si no existe o no le pertenece (no se distingue para evitar enumeración). */
  async revokeSession(userId: string, sessionId: string, reason: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE identity.sessions SET revoked_at = now(), revoke_reason = $3
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [sessionId, userId, reason],
    );
    if (rows[0]) await this.revocation.revoke(sessionId);
    return rows.length > 0;
  }

  async revokeAllSessions(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE identity.sessions SET revoked_at = now(), revoke_reason = $2
       WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $3 RETURNING id`,
      [userId, reason, exceptSessionId ?? null],
    );
    await Promise.all(rows.map((r) => this.revocation.revoke(r.id)));
    return rows.length;
  }

  async #revoke(c: PoolClient, sessionId: string, reason: string) {
    await c.query('UPDATE identity.sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, reason]);
  }

  #assertClient(clientId: string) {
    if (!this.config.CLIENT_IDS.includes(clientId)) throw new OAuthError('invalid_client', 401);
  }

  #accessToken(s: SessionRow): Promise<string> {
    return this.keys.sign(
      {
        iss: this.config.PUBLIC_BASE_URL,
        aud: this.config.API_AUDIENCE,
        sub: s.user_id,
        sid: s.id,
        did: s.device_id,
        client_id: s.client_id,
        acr: s.acr ?? ACR_BASIC,
        amr: s.amr,
        auth_time: Math.floor(new Date(s.auth_time).getTime() / 1000),
        cnf: { jkt: s.dpop_jkt },
        jti: randomUUID(),
      },
      'at+jwt',
      this.config.ACCESS_TOKEN_TTL_SECONDS,
    );
  }
}

import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { OAuthError, DpopProofGuard, type AppRequest } from '@intitaxi/nest-common';
import { z } from 'zod';
import { SigningKeys } from '../../common/signing-keys.js';
import type { AppConfig } from '../../config.js';
import { CONFIG } from '../../tokens.js';
import { TOKEN_EXCHANGE_GRANT, TokenService } from './token.service.js';

const TokenBody = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(20).max(200),
    code_verifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/),
    client_id: z.string().max(100),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(20).max(200),
    client_id: z.string().max(100),
  }),
  // RFC 8693: la app única cambia de cliente (pasajero → socio) sin otro SMS.
  z.object({
    grant_type: z.literal(TOKEN_EXCHANGE_GRANT),
    subject_token: z.string().min(20).max(4096),
    subject_token_type: z.literal('urn:ietf:params:oauth:token-type:access_token'),
    client_id: z.string().max(100),
  }),
]);
const KNOWN_GRANTS: unknown[] = ['authorization_code', 'refresh_token', TOKEN_EXCHANGE_GRANT];

@Controller()
export class TokenController {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SigningKeys) private readonly keys: SigningKeys,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Endpoint de tokens (OAuth 2.1). Clientes públicos (apps nativas): PKCE obligatorio,
   * tokens ligados a DPoP y, para el canje del código, atestación de la app.
   * Token exchange (RFC 8693): solo entre clientes móviles, en el mismo dispositivo y con la misma clave DPoP.
   */
  @Post('oauth/token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(DpopProofGuard)
  async token(@Req() req: AppRequest, @Body() body: unknown) {
    const parsed = TokenBody.safeParse(body);
    if (!parsed.success) {
      const gt = (body as { grant_type?: unknown } | undefined)?.grant_type;
      throw new OAuthError(KNOWN_GRANTS.includes(gt) ? 'invalid_request' : 'unsupported_grant_type');
    }
    const input = parsed.data;
    const jkt = req.dpop!.jkt;
    if (input.grant_type === 'authorization_code') {
      return this.tokens.exchangeCode({ code: input.code, codeVerifier: input.code_verifier, clientId: input.client_id, jkt }, req);
    }
    if (input.grant_type === TOKEN_EXCHANGE_GRANT) {
      return this.tokens.exchangeToken({ subjectToken: input.subject_token, clientId: input.client_id, jkt }, req);
    }
    return this.tokens.refresh({ refreshToken: input.refresh_token, clientId: input.client_id, jkt }, req);
  }

  /** RFC 7009: siempre 200, exista o no el token. */
  @Post('oauth/revoke')
  @HttpCode(200)
  async revoke(@Body() body: unknown) {
    const b = z.object({ token: z.string().max(200), client_id: z.string().max(100) }).safeParse(body);
    if (b.success) await this.tokens.revokeByRefreshToken(b.data.token, b.data.client_id);
    return {};
  }

  @Get('jwks')
  @Header('Cache-Control', 'public, max-age=300')
  jwks() {
    return this.keys.jwks;
  }

  @Get('.well-known/oauth-authorization-server')
  @Header('Cache-Control', 'public, max-age=3600')
  metadata() {
    const base = this.config.PUBLIC_BASE_URL;
    return {
      issuer: base,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      jwks_uri: `${base}/jwks`,
      grant_types_supported: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE_GRANT],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      dpop_signing_alg_values_supported: ['ES256', 'EdDSA'],
      authorization_challenge_endpoints: {
        otp: `${base}/v1/auth/otp/verify`,
        passkey: `${base}/v1/auth/passkeys/authentication/verify`,
        device_key: `${base}/v1/auth/device-keys/assert`,
      },
    };
  }
}


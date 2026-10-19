export type AuthErrorCode = 'invalid_token' | 'invalid_dpop_proof' | 'insufficient_user_authentication';

/** Error de autenticación. El mensaje es interno; al cliente solo se expone `code`. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

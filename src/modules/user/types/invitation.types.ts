/**
 * Request contracts for the invitation and password-reset endpoints.
 */
export interface IAcceptInvitationBody {
  password: string;
}

export interface IForgotPasswordBody {
  email: string;
}

export interface IResetPasswordBody {
  password: string;
}

/**
 * What a public token-check returns.
 *
 * Deliberately thin: enough to greet the person by name and show which
 * organization they are joining, and nothing an attacker holding a stolen link
 * would not already be about to learn anyway. No id, no role, no phone.
 */
export interface TokenPreview {
  firstName: string;
  email: string;
  organizationName: string | null;
  expiresAt: Date;
}

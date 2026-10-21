import { forbidden } from '../../errors.js';
import type { AuthContext } from '../../types.js';
import type { PreviewSessionRow } from './preview.types.js';

// Role policy. Roles come from the verified JWT; follow the platform's token refresh/revocation policy.
const MANAGER_ROLES = new Set(['owner', 'admin', 'editor']);

const isManager = (ctx: AuthContext) => ctx.roles.some((r) => MANAGER_ROLES.has(r));

export function assertCanCreate(ctx: AuthContext): void {
  if (!isManager(ctx)) throw forbidden('role_cannot_create_preview');
}

/** Session creator, or an owner/admin/editor within the same tenant/org scope (scope enforced in SQL). */
export function assertCanRevoke(ctx: AuthContext, session: PreviewSessionRow): void {
  if (session.createdByUserId === ctx.userId) return;
  if (isManager(ctx)) return;
  throw forbidden('not_creator_or_manager');
}

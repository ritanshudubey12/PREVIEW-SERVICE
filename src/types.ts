/** Identity context derived ONLY from a verified JWT, never from request headers or bodies. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  organizationId: string;
  workspaceId: string | null;
  softwareId: string | null;
  roles: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    auth?: AuthContext;
  }
}

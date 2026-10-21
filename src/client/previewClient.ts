import { randomUUID } from 'node:crypto';

export type TokenProvider = () => string | Promise<string>;

export interface PreviewClientOptions {
  baseUrl: string;
  /** Called before every protected request, so the bearer JWT is attached (and refreshed) automatically. */
  getToken: TokenProvider;
  fetchImpl?: typeof fetch;
}

export class PreviewApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'PreviewApiError';
  }
}

export class PreviewApiClient {
  private readonly baseUrl: string;
  private readonly getToken: TokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PreviewClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  createPreview(pageId: string, body: { revisionId: string; expiresInSeconds?: number }) {
    return this.request<{ previewUrl: string; expiresAt: string }>('POST', `/api/v1/pages/${pageId}/previews`, {
      auth: true,
      body,
    });
  }

  /** The preview token is itself the credential, so no JWT is sent. */
  resolvePreview(token: string) {
    return this.request<{ websiteId: string; pageId: string; revisionId: string; expiresAt: string; readOnly: true }>(
      'GET',
      `/api/v1/previews/${token}`,
      { auth: false },
    );
  }

  async revokePreview(token: string): Promise<void> {
    await this.request<null>('DELETE', `/api/v1/previews/${token}`, { auth: true });
  }

  private async request<T>(method: string, path: string, opts: { auth: boolean; body?: unknown }): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Request-Id': `req_${randomUUID()}`,
    };
    if (opts.auth) headers.Authorization = `Bearer ${await this.getToken()}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (res.status === 204) return null as T;

    const json = (await res.json().catch(() => null)) as
      | { success: boolean; data?: T; error?: { code: string; message: string }; meta?: { requestId?: string } }
      | null;
    if (!res.ok || !json?.success) {
      throw new PreviewApiError(
        res.status,
        json?.error?.code ?? 'UNKNOWN',
        json?.error?.message ?? `Request failed with status ${res.status}`,
        json?.meta?.requestId,
      );
    }
    return json.data as T;
  }
}

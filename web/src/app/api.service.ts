import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import type { Approval, AuditRow, ClientRow, StatusInfo, ToolEntry, Upstream } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  authError = false;

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await lastValueFrom(
        this.http.request<T>(method, `/api${path}`, {
          body: body as never,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        this.authError = true;
      }
      throw err;
    }
  }

  status() {
    return this.request<StatusInfo>('GET', '/status');
  }

  listUpstreams() {
    return this.request<{ upstreams: Upstream[] }>('GET', '/upstreams');
  }

  createUpstream(body: { namespace: string; displayName?: string; url: string; driftAction?: string }) {
    return this.request<{ ok: boolean }>('POST', '/upstreams', body);
  }

  updateUpstream(namespace: string, body: Partial<Upstream>) {
    return this.request<{ ok: boolean }>('PUT', `/upstreams/${namespace}`, body);
  }

  deleteUpstream(namespace: string) {
    return this.request<{ ok: boolean }>('DELETE', `/upstreams/${namespace}`);
  }

  pinUpstream(namespace: string) {
    return this.request<{ ok: boolean; hash?: string; toolCount?: number }>('POST', `/upstreams/${namespace}/pin`);
  }

  tools(namespace: string) {
    return this.request<{ namespace: string; state: string; tools: ToolEntry[] }>('GET', `/upstreams/${namespace}/tools`);
  }

  setToolPolicy(namespace: string, tool: string, body: Partial<ToolEntry>) {
    return this.request<{ ok: boolean }>('PUT', `/upstreams/${namespace}/policies/${tool}`, body);
  }

  deleteToolPolicy(namespace: string, tool: string) {
    return this.request<{ ok: boolean }>('DELETE', `/upstreams/${namespace}/policies/${tool}`);
  }

  approvals(status?: string) {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request<{ approvals: Approval[] }>('GET', `/approvals${q}`);
  }

  resolveApproval(id: string, action: 'approve' | 'deny') {
    return this.request<{ ok: boolean }>('POST', `/approvals/${id}/resolve`, { action });
  }

  audit(params: { tool?: string; limit?: number }) {
    const q = new URLSearchParams();
    if (params.tool) q.set('tool', params.tool);
    if (params.limit) q.set('limit', String(params.limit));
    return this.request<{ rows: AuditRow[] }>('GET', `/audit?${q.toString()}`);
  }

  settings() {
    return this.request<{ settings: Record<string, string> }>('GET', '/settings');
  }

  saveSettings(settings: Record<string, string>) {
    return this.request<{ settings: Record<string, string> }>('PUT', '/settings', { settings });
  }

  clients() {
    return this.request<{ clients: ClientRow[] }>('GET', '/clients');
  }

  createClient(name: string) {
    return this.request<{ ok: boolean; client_id: string; token: string }>('POST', '/clients', { name });
  }

  deleteClient(id: string) {
    return this.request<{ ok: boolean }>('DELETE', `/clients/${id}`);
  }

  secrets() {
    return this.request<{ secrets: { name: string; created_at: string }[] }>('GET', '/secrets');
  }

  saveSecret(name: string, value: string) {
    return this.request<{ ok: boolean }>('PUT', `/secrets/${name}`, { value });
  }

  deleteSecret(name: string) {
    return this.request<{ ok: boolean }>('DELETE', `/secrets/${name}`);
  }
}

/**
 * HTTP Client for Buildfunctions API
 */

import { BuildfunctionsError, AuthenticationError } from './errors.js';

export interface HttpClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  params?: Record<string, string | number>;
}

export interface HttpClient {
  request: <T>(options: RequestOptions) => Promise<T>;
  get: <T>(path: string, params?: Record<string, string | number>) => Promise<T>;
  post: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
  put: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
  delete: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
  setToken: (token: string) => void;
}

export function createHttpClient(config: HttpClientConfig): HttpClient {
  if (!config.apiKey) {
    throw new AuthenticationError('API key is required');
  }

  const baseUrl = config.baseUrl.replace(/\/$/, '');
  let currentToken = config.apiKey;
  const timeout = config.timeout ?? 600000; // 10 minutes default for long-running builds

  const buildUrl = (path: string, params?: Record<string, string | number>): string => {
    const url = new URL(path, baseUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  };

  const parseResponse = async (response: Response): Promise<unknown> => {
    const contentType = response.headers.get('content-type');

    if (contentType?.includes('application/json')) {
      return response.json();
    }

    const text = await response.text();
    return { message: text };
  };

  const request = async <T>(options: RequestOptions): Promise<T> => {
    const url = buildUrl(options.path, options.params);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken}`,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await parseResponse(response);

      if (!response.ok) {
        throw BuildfunctionsError.fromResponse(response.status, data as { error?: string; code?: string });
      }

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof BuildfunctionsError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new BuildfunctionsError('Request timed out', 'NETWORK_ERROR');
        }
        throw new BuildfunctionsError('Unable to connect to server', 'NETWORK_ERROR');
      }

      throw new BuildfunctionsError('Request failed', 'UNKNOWN_ERROR');
    }
  };

  return {
    request,
    get: <T>(path: string, params?: Record<string, string | number>) =>
      request<T>({ method: 'GET', path, params }),
    post: <T>(path: string, body?: Record<string, unknown>) =>
      request<T>({ method: 'POST', path, body }),
    put: <T>(path: string, body?: Record<string, unknown>) =>
      request<T>({ method: 'PUT', path, body }),
    delete: <T>(path: string, body?: Record<string, unknown>) =>
      request<T>({ method: 'DELETE', path, body }),
    setToken: (token: string) => {
      currentToken = token;
    },
  };
}

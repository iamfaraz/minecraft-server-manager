export class ApiError extends Error {
  /** `data` is the rest of the error response, for errors the UI can act on (`data.code` says which). */
  constructor(public status: number, message: string, public data: Record<string, any> = {}) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json', ...(init.headers || {}) } : init.headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    ...init,
  });
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('mcsm:unauthorized'));
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText || 'Request failed', data && typeof data === 'object' ? data : {});
  return data as T;
}

/** Upload with progress (fetch cannot report upload progress). */
export function uploadWithProgress<T>(url: string, file: File, onProgress: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: network error'));
    xhr.onload = () => {
      let data: any = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = { error: xhr.responseText };
      }
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent('mcsm:unauthorized'));
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data?.error || xhr.statusText || 'Upload failed', data || {}));
    };
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, file: File, fields: Record<string, string> = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', file, file.name);
    return request<T>('POST', url, fd);
  },
};

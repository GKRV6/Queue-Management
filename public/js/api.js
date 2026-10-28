// Thin fetch wrapper around the { success, data, error } envelope.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    throw new ApiError(res.status, `Unexpected response from server (${res.status})`);
  }
  if (!res.ok || !payload.success) {
    const err = new ApiError(res.status, payload.error || `Request failed (${res.status})`);
    if (res.status === 401) window.dispatchEvent(new CustomEvent('qws:unauthorized'));
    throw err;
  }
  return payload.data;
}

function qs(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
}

export const api = {
  get: (url, params) => request('GET', url + qs(params)),
  post: (url, body) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};

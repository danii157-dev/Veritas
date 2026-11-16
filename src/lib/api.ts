const apiUrl = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV
  ? `${window.location.protocol}//${window.location.hostname}:4000`
  : '');

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The server could not complete this request.');
  return result as T;
}

export async function apiRequestBlob(path: string): Promise<Blob> {
  const response = await fetch(`${apiUrl}${path}`, { credentials: 'include' });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'The server could not complete this request.');
  }
  return response.blob();
}

/**
 * Fetch consumes a Request body. Keep a pre-fetch clone for the optional 401
 * token-refresh replay performed by the API client.
 */
export function cloneRequestForReplay(request: Request): Request {
  return request.clone();
}

/**
 * Compliance pre-flight for GPU builds.
 *
 * GPU functions and GPU sandboxes post straight to the storage/build server,
 * bypassing every buildfunctions build route — so before we send that request
 * we ask buildfunctions (which sees the caller's live request geo) whether this
 * build is allowed from the caller's country. A blocked country throws here,
 * before anything is provisioned.
 *
 * The country decision is made server-side from the live request geo — this SDK
 * only relays the verdict.
 */
import { BuildfunctionsError } from './errors.js';

export interface CompliancePreflightParams {
  baseUrl: string;
  apiToken: string;
  /** The build body, so the server can detect a custom-model (Bucket C) build. */
  body: Record<string, unknown>;
}

/**
 * Throws BuildfunctionsError (451 hard-block / 403 review) when the build is not
 * permitted from the caller's country. Resolves silently when allowed. A network
 * error reaching the check is treated as allow (fail-open) so a transient glitch
 * never blocks a legitimate build — matching Layer-1's default policy.
 */
export async function assertBuildAllowed({ baseUrl, apiToken, body }: CompliancePreflightParams): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/sdk/compliance/check-build`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    return; // fail-open on network error
  }

  if (res.ok) return;

  // Only the compliance statuses are enforced; anything else falls through to the
  // real build (which will surface its own error).
  if (res.status === 451 || res.status === 403) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw BuildfunctionsError.fromResponse(res.status, data);
  }
}

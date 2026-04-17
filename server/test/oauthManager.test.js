/**
 * Unit tests for `oauthManager.getOAuthToken`.
 *
 * Focus: the `oauth_token_refreshed` audit trail that backs §8 item 3
 * of docs/EMAIL_AUTH_MVP.md ("sync >1h dispara refresh silencioso
 * observável em CurveLog"). MSAL is stubbed via the `overrides.app`
 * seam; audit is captured via `overrides.audit` so no MongoDB or Azure
 * round-trip is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getOAuthToken,
  OAuthReAuthRequired,
} from '../src/services/oauthManager.js';

function makeConfig(extra = {}) {
  return {
    user_id: 'user-1',
    oauth_provider: 'microsoft',
    oauth_account_id: 'home-123',
    oauth_client_id: 'client-abc',
    oauth_tenant_id: 'common',
    ...extra,
  };
}

function makeApp({ account = { username: 'alice@outlook.pt' }, acquireResult }) {
  return {
    getTokenCache: () => ({
      getAccountByHomeId: async () => account,
    }),
    acquireTokenSilent: async () => {
      if (acquireResult instanceof Error) throw acquireResult;
      return acquireResult;
    },
  };
}

function captureAudit() {
  const calls = [];
  return {
    audit: (payload) => calls.push(payload),
    calls,
  };
}

test('fromCache=false triggers oauth_token_refreshed audit with accountId and email', async () => {
  const { audit, calls } = captureAudit();
  const app = makeApp({
    acquireResult: { accessToken: 'tok-new', fromCache: false },
  });

  const token = await getOAuthToken(makeConfig(), { app, audit });

  assert.equal(token, 'tok-new');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'oauth_token_refreshed');
  assert.equal(calls[0].userId, 'user-1');
  assert.match(calls[0].detail, /provider=microsoft/);
  assert.match(calls[0].detail, /accountId=home-123/);
  assert.match(calls[0].detail, /email=alice@outlook\.pt/);
});

test('fromCache=true does NOT trigger the audit (cache hit)', async () => {
  const { audit, calls } = captureAudit();
  const app = makeApp({
    acquireResult: { accessToken: 'tok-cached', fromCache: true },
  });

  const token = await getOAuthToken(makeConfig(), { app, audit });

  assert.equal(token, 'tok-cached');
  assert.equal(calls.length, 0);
});

test('fromCache=undefined is conservative: NO audit fires', async () => {
  // Defends against future MSAL versions dropping/renaming the flag.
  // Better to under-report refreshes than to log a "refresh" that
  // didn't actually happen.
  const { audit, calls } = captureAudit();
  const app = makeApp({
    acquireResult: { accessToken: 'tok-maybe' },
  });

  await getOAuthToken(makeConfig(), { app, audit });

  assert.equal(calls.length, 0);
});

test('InteractionRequiredAuthError is translated to OAuthReAuthRequired; no audit', async () => {
  const { audit, calls } = captureAudit();
  const { InteractionRequiredAuthError } = await import('@azure/msal-node');
  const mssrErr = new InteractionRequiredAuthError(
    'invalid_grant',
    'refresh token expired',
  );
  const app = makeApp({ acquireResult: mssrErr });

  await assert.rejects(
    () => getOAuthToken(makeConfig(), { app, audit }),
    (err) => err instanceof OAuthReAuthRequired,
  );
  assert.equal(calls.length, 0);
});

test('missing oauth_account_id throws OAuthReAuthRequired synchronously (wizard not done)', async () => {
  const { audit, calls } = captureAudit();
  const config = makeConfig({ oauth_account_id: null });

  await assert.rejects(
    () => getOAuthToken(config, { audit }),
    (err) => err instanceof OAuthReAuthRequired,
  );
  assert.equal(calls.length, 0);
});

test('cache returns no account → OAuthReAuthRequired (cache corrupt/wiped)', async () => {
  const { audit, calls } = captureAudit();
  const app = {
    getTokenCache: () => ({ getAccountByHomeId: async () => null }),
    acquireTokenSilent: async () => {
      throw new Error('should not reach here');
    },
  };

  await assert.rejects(
    () => getOAuthToken(makeConfig(), { app, audit }),
    (err) => err instanceof OAuthReAuthRequired,
  );
  assert.equal(calls.length, 0);
});

test('generic network error bubbles up without marking token dead', async () => {
  // §3.7 of EMAIL_AUTH.md: only InteractionRequiredAuthError is
  // terminal. Transient 5xx / network errors must propagate so the
  // orchestrator retries on the next schedule.
  const { audit, calls } = captureAudit();
  const netErr = new Error('ETIMEDOUT');
  const app = makeApp({ acquireResult: netErr });

  await assert.rejects(
    () => getOAuthToken(makeConfig(), { app, audit }),
    (err) => err.message === 'ETIMEDOUT' && !(err instanceof OAuthReAuthRequired),
  );
  assert.equal(calls.length, 0);
});

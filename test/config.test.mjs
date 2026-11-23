// The settings in .stillhunter/config.json that this version reads: what is
// refused and why, which sign-in variables a probe gets, when the reset runs,
// and start's --url.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configProblems, hostPolicy, resetsEveryProbe, resetTimeoutMs, signInVariableNames, unsetSignInVariables } from '../dist/common.mjs';
import { parseStartFlags } from '../dist/flags.mjs';

test('a config with only the settings it had before still passes', () => {
  assert.deepEqual(configProblems({}), []);
  assert.deepEqual(configProblems({ target: { url: 'http://localhost:3000' }, browser: 'chrome', reset: 'npm run reset', other: 1 }), []);
});

test('each new setting says what is wrong with it', () => {
  const one = (c) => { const p = configProblems(c); assert.equal(p.length, 1, JSON.stringify(p)); return p[0]; };
  assert.match(one({ reset: 'x', resetBefore: 'sometimes' }), /"resetBefore" is "every-probe" or "re-runs"/);
  assert.match(one({ resetBefore: 're-runs' }), /needs a "reset" command/);
  assert.match(one({ reset: 'x', resetTimeoutSeconds: 301 }), /from 1 to 300/);
  assert.match(one({ reset: 'x', resetTimeoutSeconds: 2.5 }), /whole number/);
  assert.match(one({ reset: '' }), /"reset" is a shell command/);
  assert.match(one({ signIn: { variables: 'APP_EMAIL' } }), /list of environment variable names/);
  assert.match(one({ signIn: { variables: ['APP EMAIL'] } }), /not an environment variable name/);
  for (const v of ['NODE_OPTIONS', 'PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PLAYWRIGHT_BROWSERS_PATH', 'node_options']) {
    assert.match(one({ signIn: { variables: [v] } }), /changes how Node or the browser runs/, v);
  }
  assert.match(one({ network: ['api.example.com'] }), /"network" is an object/);
  assert.match(one({ network: { allow: 'api.example.com' } }), /"network.allow" is a list/);
  assert.match(one({ network: { allowForSignIn: ['https://login.example.com'] } }), /"network.allowForSignIn": .*no scheme/);
  assert.deepEqual(configProblems([]), ['it must be a JSON object']);
});

test('signIn.variables names exactly the variables a probe gets; without it, the name endings decide', () => {
  const env = { APP_EMAIL: 'a', APP_PASSWORD: 'b', SYNC_TEST_LOGIN_TOKEN: 'c', OTHER_PASS: 'd', USER: 'me' };
  assert.deepEqual(signInVariableNames(env), ['APP_EMAIL', 'APP_PASSWORD', 'OTHER_PASS']);
  const config = { signIn: { variables: ['SYNC_TEST_LOGIN_TOKEN', 'APP_EMAIL', 'APP_EMAIL'] } };
  assert.deepEqual(signInVariableNames(env, config), ['APP_EMAIL', 'SYNC_TEST_LOGIN_TOKEN']);
  assert.deepEqual(unsetSignInVariables(config, env), []);
  assert.deepEqual(unsetSignInVariables({ signIn: { variables: ['MISSING_ONE', 'APP_EMAIL'] } }, env), ['MISSING_ONE']);
  assert.deepEqual(unsetSignInVariables({}, env), []);
});

test('the reset runs before every probe unless the config says re-runs, and its time limit can be raised', () => {
  assert.equal(resetsEveryProbe({}), false);
  assert.equal(resetsEveryProbe({ reset: 'x' }), true);
  assert.equal(resetsEveryProbe({ reset: 'x', resetBefore: 'every-probe' }), true);
  assert.equal(resetsEveryProbe({ reset: 'x', resetBefore: 're-runs' }), false);
  assert.equal(resetTimeoutMs({}), 120_000);
  assert.equal(resetTimeoutMs({ resetTimeoutSeconds: 240 }), 240_000);
});

test('the sign-in hosts go only to a probe that may sign in', () => {
  const config = { network: { allow: ['API.example.com'], allowForSignIn: ['*.auth0.com'] } };
  assert.deepEqual(hostPolicy(config, true), { allow: ['api.example.com'], signIn: ['*.auth0.com'] });
  assert.deepEqual(hostPolicy(config, false), { allow: ['api.example.com'], signIn: [] });
  assert.deepEqual(hostPolicy({}, true), { allow: [], signIn: [] });
});

test('start takes the app\'s local URL with --url, keeping only its origin', () => {
  const url = (v) => parseStartFlags(['--url', v]);
  assert.equal(url('http://localhost:5173/some/page?x=1').flags.url, 'http://localhost:5173');
  assert.equal(url('https://127.0.0.1:8443').flags.url, 'https://127.0.0.1:8443');
  assert.equal(parseStartFlags([]).flags.url, null);
  for (const bad of ['localhost:5173', 'https://staging.example.com', 'file:///etc/hosts', 'ftp://localhost/']) {
    const r = url(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.message, /--url is the app's address on this machine/);
  }
});

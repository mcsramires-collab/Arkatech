import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.lab-validation', 'activation-notice.cjs');
buildSync({
  entryPoints: [path.join(root, 'src/components/PendingActivationNotice.tsx')],
  outfile: output, bundle: true, platform: 'node', format: 'cjs',
  external: ['react', 'react-dom'], jsx: 'automatic'
});
const { PendingActivationNotice } = createRequire(import.meta.url)(output);

test('pending state directs users to the received invitation and authorized resend', () => {
  const html = renderToStaticMarkup(React.createElement(PendingActivationNotice, { termoVersao: 'v-fixture' }));
  assert.match(html, /Sua conta ainda não foi ativada/);
  assert.match(html, /Termo de Uso: v-fixture/);
  assert.match(html, /link de convite recebido por e-mail/);
  assert.match(html, /solicite o reenvio à sua seguradora ou corretora/);
  assert.doesNotMatch(html, /<button|<a |token_pendente|Conta ativada com sucesso/);
});

test('pending state remains usable when no term version or invitation is exposed', () => {
  const html = renderToStaticMarkup(React.createElement(PendingActivationNotice));
  assert.match(html, /link de convite recebido por e-mail/);
  assert.doesNotMatch(html, /undefined|null|Termo de Uso:|<button/);
});

test('legacy portal consumes only public state and has no direct activation shortcut', () => {
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'src/services/api.ts'), 'utf8');
  assert.match(app, /<PendingActivationNotice termoVersao=\{portalActivation\.termo_versao\}/);
  assert.doesNotMatch(app + api, /token_pendente|handleAcceptActivation|acceptActivation/);
});

import { spawnSync } from 'child_process';
import { createRequire } from 'module';

// Resolve through the actual consumers, rather than an unrelated nested copy.
const expressRequire = createRequire(require.resolve('express/package.json'));
const minimatchRequire = createRequire(require.resolve('minimatch/package.json'));
const proxyaddr = expressRequire('proxy-addr');
const expand = minimatchRequire('brace-expansion');

describe('runtime dependency regressions', () => {
  // Library-level defense in depth. The application does not currently configure
  // trust proxy; these cases do not claim a reachable application exploit.
  describe('proxy-addr trust boundaries (GHSA-jqcg-44mw-7w3h)', () => {
    test.each(['::ffff:10.0.0.0/8', '::/1']) (
      'does not trust IPv4 clients through the IPv6 subnet %s',
      (subnet) => {
        for (const ranges of [[subnet], [subnet, '2001:db8::/32']]) {
          const trust = proxyaddr.compile(ranges);
          expect(trust('203.0.113.10')).toBe(false);
          expect(trust('::ffff:203.0.113.10')).toBe(false);
          expect(proxyaddr({
            socket: { remoteAddress: '203.0.113.10' },
            headers: { 'x-forwarded-for': '192.0.2.123' }
          }, trust)).toBe('203.0.113.10');
        }
      }
    );

    test.each(['10.0.0.0/8', '::ffff:10.0.0.0/104']) (
      'preserves correctly scoped trusted forwarding for %s',
      (subnet) => {
        const trust = proxyaddr.compile(subnet);
        expect(trust('10.1.2.3')).toBe(true);
        expect(trust('::ffff:10.1.2.3')).toBe(true);
        expect(trust('203.0.113.10')).toBe(false);
        expect(proxyaddr({
          socket: { remoteAddress: '10.1.2.3' },
          headers: { 'x-forwarded-for': '192.0.2.123' }
        }, trust)).toBe('192.0.2.123');
      }
    );

    test('preserves native IPv6 subnet matching', () => {
      const trust = proxyaddr.compile('2001:db8::/32');
      expect(trust('2001:db8::1')).toBe(true);
      expect(trust('2001:db9::1')).toBe(false);
      expect(trust('203.0.113.10')).toBe(false);
    });
  });

  describe('brace-expansion parsing bounds', () => {
    test('preserves ordinary nested alternatives and padded sequences', () => {
      expect(expand('file-{a,{b,c}}-{01..03..2}.csv')).toEqual([
        'file-a-01.csv', 'file-a-03.csv',
        'file-b-01.csv', 'file-b-03.csv',
        'file-c-01.csv', 'file-c-03.csv'
      ]);
      expect(expand('file-\\{literal\\}.csv')).toEqual(['file-{literal}.csv']);
      expect(expand('{a},b}')).toEqual(['a}', 'b']);
    });

    test('honors a small nesting-depth cap (GHSA-qhr7-859c-m2p7)', () => {
      const pattern = '{'.repeat(30) + 'a,b' + '}'.repeat(30);
      expect(expand(pattern, { maxDepth: 4 })).toEqual([pattern]);
    });

    test('honors a small rewrite cap (GHSA-q2hr-2g5m-vwhr)', () => {
      const pattern = '{a}' + '}'.repeat(10) + ',z}';
      expect(expand(pattern, { maxRewrites: 2 })).toEqual([pattern]);
    });

    test('parses comma groups without stack exhaustion (GHSA-6j4f-fj2g-mc7p)', () => {
      // Keep the potentially regressed parser outside Jest, with bounded heap,
      // wall time, input and output. No server or external service is involved.
      const result = spawnSync(process.execPath, [
        '--max-old-space-size=64', '-e',
        `const assert = require('node:assert/strict');
         const expand = require(process.argv[1]);
         const result = expand('{' + '{a},'.repeat(10000) + 'b}',
           { max: 4, maxLength: 100 });
         assert.deepEqual(result, ['{a}', '{a}', '{a}', '{a}']);
         process.stdout.write('ok');`,
        minimatchRequire.resolve('brace-expansion')
      ], {
        encoding: 'utf8',
        env: { NODE_ENV: 'test' },
        timeout: 5000,
        killSignal: 'SIGKILL',
        maxBuffer: 4096
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('ok');
    });
  });
});

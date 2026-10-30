import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Network, isPublicAddress } from '../src/network.ts';

Deno.test('public-address policy rejects local, mapped and reserved networks', () => {
  for (const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','192.168.1.1','100.64.0.1','::1','::ffff:127.0.0.1',
    'fc00::1','fe80::1','2001:db8::1','2002:7f00:1::','224.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

Deno.test('requests pin hostname DNS, bound bodies and reject redirects/private access', async () => {
  const server = http.createServer((req,res) => {
    if (req.url === '/redirect') res.writeHead(302,{location:'http://127.0.0.1/secret'}).end();
    else res.end('fixture');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1',done));
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await new Network(true).request(url)).toString(), 'fixture');
    await assert.rejects(new Network(true).request(url, {maxBytes:2}), /size limit/);
    await assert.rejects(new Network(true).request(`${url}/redirect`), /HTTP 302/);
    await assert.rejects(new Network().request(url), /HTTPS required/);
    await assert.rejects(new Network().request('https://127.0.0.1/'), /Non-public/);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

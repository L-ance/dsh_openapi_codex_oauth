import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('declares a DSH bundle and Web client entrypoint', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')

  const patch = await readFile('cordis.patch.yml', 'utf8')
  assert.match(patch, /name: dsh-openapi-codex-oauth/)
})

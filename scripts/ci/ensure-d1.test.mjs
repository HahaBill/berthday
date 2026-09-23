import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDatabase } from './ensure-d1.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const berthday = { uuid: id, name: 'berthday' };
const unexpectedCreate = () => { throw new Error('Unexpected database creation'); };

test('a supplied ID must belong to berthday', async () => {
  await assert.rejects(resolveDatabase({
    suppliedId: id, listDatabases: () => [{ uuid: id, name: 'another-app' }], createDatabase: unexpectedCreate,
  }), /must be named "berthday"/);
});

test('a supplied ID must exist in the configured account', async () => {
  await assert.rejects(resolveDatabase({
    suppliedId: id, listDatabases: () => [], createDatabase: unexpectedCreate,
  }), /not found/);
});

test('invalid IDs are rejected before querying the account', async () => {
  await assert.rejects(resolveDatabase({
    suppliedId: 'not-a-uuid', listDatabases: unexpectedCreate, createDatabase: unexpectedCreate,
  }), /valid database UUID/);
});

test('valid supplied IDs and existing named databases are reused', async () => {
  for (const suppliedId of [id, ` ${id} `, '']) {
    assert.equal(await resolveDatabase({
      suppliedId, listDatabases: () => [berthday], createDatabase: unexpectedCreate,
    }), id);
  }
});

test('an absent named database is created once and its ID is looked up', async () => {
  let created = 0;
  assert.equal(await resolveDatabase({
    listDatabases: () => created ? [{ database_id: id, database_name: 'berthday' }] : [],
    createDatabase(name) { assert.equal(name, 'berthday'); created++; },
  }), id);
  assert.equal(created, 1);
});

test('a failed creation cannot leave a placeholder ID in the config', async () => {
  await assert.rejects(resolveDatabase({ listDatabases: () => [], createDatabase: () => {} }), /Could not resolve/);
});

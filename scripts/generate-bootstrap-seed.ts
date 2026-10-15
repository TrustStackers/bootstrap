#!/usr/bin/env node
/**
 * generate-bootstrap-seed — generate a random 32-byte Ed25519 seed, its
 * 24-word BIP-39 word sequence, and the resulting libp2p peer ID.
 *
 * Run: npm run gen-seed
 *
 * This prints the values ONLY (no address, no file written). To derive the peer
 * ID from a word sequence and write it into a component `.env`, use
 * `npm run init:bootstrap` — that is the supported path.
 */

import { keys } from '@libp2p/crypto';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { randomBytes } from 'node:crypto';
import { exportSeedPhrase } from '@p2p-trust-stack/core/crypto/seed-phrase.js';

const seed = new Uint8Array(randomBytes(32));
const seedHex = Buffer.from(seed).toString('hex');

const privateKey = await keys.generateKeyPairFromSeed('Ed25519', seed);
const peerId = await peerIdFromPrivateKey(privateKey);
const { mnemonic } = exportSeedPhrase({ secretKey: seed, publicKey: privateKey.publicKey.raw });

console.log('Seed (hex):    ', seedHex);
console.log('Word sequence: ', mnemonic);
console.log('Peer ID:       ', peerId.toString());
console.log('');
console.log('To write a component .env with these values:');
console.log(`  npm run init:bootstrap -- --words "${mnemonic}" --host <dns-or-ip>`);
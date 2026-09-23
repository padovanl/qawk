// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

import { S, upload } from './api.js';
import { fail } from './chrome.js';
import { $ } from './dom.js';
import { bytes, download } from './util.js';

/* ------------------------------------------------- reading a .swu in the browser
 *
 * The console could upload anything: it POSTed the file and hoped. Everything
 * upload-swu.sh refuses -- an unsigned package, a delta without its .zck, a
 * .zck named differently from what the manifest asks for, a pair from two
 * different builds -- went through the GUI unchecked, which made the friendlier
 * path the dangerous one.
 *
 * The same reading is possible here. A .swu is a cpio archive whose first entry
 * is sw-description, and File.slice() means only the few kilobytes that matter
 * are ever read: a 600 MB package is inspected without loading 600 MB.
 *
 * The walk is written against a read(offset, length) function rather than a
 * File so the same code can be exercised outside a browser. */
async function cpioWalk(read, size) {
  const td = new TextDecoder();
  const out = [];
  let off = 0;
  while (off + 110 <= size) {
    const hdr = await read(off, 110);
    const magic = td.decode(hdr.subarray(0, 6));
    if (magic !== '070701' && magic !== '070702') break;
    const f = [];
    for (let i = 0; i < 13; i++) f.push(parseInt(td.decode(hdr.subarray(6 + i * 8, 14 + i * 8)), 16));
    const fsize = f[6], nsize = f[11];
    if (!Number.isFinite(fsize) || !Number.isFinite(nsize)) break;
    const name = td.decode((await read(off + 110, nsize)).subarray(0, Math.max(0, nsize - 1)));
    let p = off + 110 + nsize;
    p += (4 - (p % 4)) % 4;
    if (name === 'TRAILER!!!') break;
    out.push({ name, size: fsize, offset: p });
    p += fsize;
    p += (4 - (p % 4)) % 4;
    off = p;
  }
  return out;
}

function parseSwDescription(text) {
  const one = re => (text.match(re) || [])[1] || '';
  const deltaSource = one(/\bsource\s*=\s*"([^"]*)"/);
  let base = '';
  const m = deltaSource.match(/\/versions\/(.+)\.img$/);
  if (m) base = m[1];
  else if (deltaSource.includes('by-partlabel')) base = 'the other slot';
  return {
    version: one(/\bversion\s*=\s*"([^"]*)"/),
    hw: one(/hardware-compatibility\s*:\s*\[\s*"([^"]*)"/),
    zckfile: one(/\bzckfile\s*=\s*"([^"]*)"/),
    zckheader: one(/filename\s*=\s*"([^"]*)"\s*;\s*type\s*=\s*"delta"/),
    delta: /\btype\s*=\s*"delta"/.test(text),
    kind: /\bbootloader_state_marker\s*=\s*false/.test(text) ? 'app'
        : (/\bbootenv\s*:/.test(text) || text.includes('by-partlabel')) ? 'os' : 'unknown',
    appName: (one(/filename\s*=\s*"qamf-app-postinstall\.sh"[\s\S]*?data\s*=\s*"([^"]*)"/) || '').split(/\s+/)[0] || '',
    machine: (one(/\bdescription\s*=\s*"([^"]*)"/).split(/\s+/)[0] === 'QubicaAMF'
              ? one(/\bdescription\s*=\s*"([^"]*)"/).split(/\s+/)[1] : '') || '',
    deltaSource, base,
  };
}

const fileReader = file => async (off, len) =>
  new Uint8Array(await file.slice(off, off + len).arrayBuffer());

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function inspectSwu(file) {
  const read = fileReader(file);
  const ents = await cpioWalk(read, file.size);
  if (!ents.length) throw new Error(`${file.name} is not a cpio archive: this is not a .swu`);
  if (ents[0].name !== 'sw-description') {
    throw new Error(`${file.name}: the first entry is "${ents[0].name}", not sw-description — SWUpdate would refuse it`);
  }
  const text = new TextDecoder().decode(await read(ents[0].offset, ents[0].size));
  return Object.assign(parseSwDescription(text), {
    entries: ents,
    signed: ents.some(e => e.name === 'sw-description.sig'),
    name: file.name,
  });
}

/* The checks upload-swu.sh makes, made here too. Each one refuses something
 * that otherwise fails on a device half an hour later, with an error that does
 * not name the cause. Returns the list of files to upload, in order. */
async function validateUpload(files, module, existing) {
  const swus = files.filter(f => f.name.endsWith('.swu'));
  const zcks = files.filter(f => f.name.endsWith('.zck'));
  const others = files.filter(f => !f.name.endsWith('.swu') && !f.name.endsWith('.zck'));
  if (swus.length > 1) throw new Error('pick one .swu at a time: a module holding two is offered whole, and the device installs whichever it picks first');
  if (!swus.length) {
    if (!others.length && !zcks.length) throw new Error('nothing to upload');
    return { files, notes: ['no .swu among these files: uploading them unchecked'] };
  }

  const swu = swus[0];
  const info = await inspectSwu(swu);
  const notes = [];

  if (!info.signed) {
    throw new Error(`${swu.name} is not signed (no sw-description.sig).\n` +
      'The image checks signatures: the device would refuse it after downloading it in full.');
  }
  // The module's type is what tells hawkBit what this is; a system package in an
  // 'application' module is offered as an app update and vice versa.
  const want = info.kind === 'os' ? 'os' : 'application';
  if (info.kind !== 'unknown' && module.type !== want) {
    throw new Error(`this is a ${info.kind === 'os' ? 'system' : 'application'} package, but the module is of type "${module.type}".\n` +
      `It belongs in a module of type "${want}".`);
  }
  const otherSwu = (existing || []).find(n => n.endsWith('.swu') && n !== swu.name);
  if (otherSwu) throw new Error(`this module already holds ${otherSwu}. A module takes one .swu (plus its .zck for a delta).`);

  if (info.delta) {
    if (!info.zckfile) throw new Error(`${swu.name} is a delta but its manifest names no zckfile`);
    const haveIt = (existing || []).includes(info.zckfile);
    const zck = zcks.find(z => z.name === info.zckfile);
    if (!zck && !haveIt) {
      const wrong = zcks.length ? `\nYou picked ${zcks[0].name}; the manifest asks for exactly that name.` : '';
      throw new Error(`this is a delta: it carries only the chunk index and needs ${info.zckfile} beside it.` + wrong +
        '\nWithout it the device downloads a header and fails.');
    }
    if (zck) {
      // Same build or nothing: the .zckheader inside the package IS the head of
      // the .zck, so the bytes settle it.
      const he = info.entries.find(e => e.name === info.zckheader);
      if (he) {
        const read = fileReader(swu);
        const a = await sha256Hex(await read(he.offset, he.size));
        const b = await sha256Hex(new Uint8Array(await zck.slice(0, he.size).arrayBuffer()));
        if (a !== b) {
          throw new Error(`${swu.name} and ${zck.name} come from DIFFERENT builds.\n` +
            'The chunk index in the package does not describe that file: the device would ' +
            'download everything and then fail. Rebuild the image and the delta together.');
        }
        notes.push('delta pair verified: the index matches the .zck byte for byte');
      }
    }
    if (info.base) notes.push(info.base === 'the other slot'
      ? 'system delta: no fixed base, it rebuilds against the slot in use'
      : `application delta: it only applies to a device already on ${info.base}`);
  } else if (zcks.length) {
    notes.push('this is not a delta; the .zck will be uploaded but nothing will ask for it');
  }

  notes.unshift(`${info.kind === 'os' ? 'system' : 'application'} ${info.delta ? 'delta' : 'full'}` +
    (info.version ? ` · version ${info.version}` : '') + (info.hw ? ` · hardware ${info.hw}` : ''));
  // The .swu first: hawkBit serves them independently, but a half-uploaded pair
  // reads better with the package present.
  return { files: [swu].concat(zcks, others), notes, info };
}

export {
  validateUpload,
};

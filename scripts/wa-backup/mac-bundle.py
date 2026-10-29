#!/usr/bin/env python3
"""
Turn the chats the WhatsApp Mac app synced from the phone into an import bundle for the CRM —
the same chats.json + media/ + chats.csv that make-bundle.py writes from a phone backup, so
server/scripts/import-wa-backup.js imports either.

The Mac app keeps its chats in an ordinary database (ChatStorage.sqlite), each customer known by
WhatsApp's hidden id (…@lid); LID.sqlite maps those to phone numbers. A photo or file is only on
the Mac once the app has downloaded it, so --media-dir can also point at the phone's own
WhatsApp Business/Media folder: a file there of exactly the size WhatsApp recorded, from the same
few days, is taken as that message's file.

Read copies, not the live files (sqlite3 <live> ".backup copy.sqlite"), so the app keeps running.

Labels and notes come from AppState.sqlite (in the container's AppState/<id>/ folder), which holds
them for every chat the phone has labelled; a labelled chat whose messages didn't come across goes
into the bundle with its labels and notes and no messages.

    python3 mac-bundle.py --db ChatStorage.sqlite --lid LID.sqlite [--app-state AppState.sqlite]
        [--labels Labels.sqlite] [--mac-media "~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message"]
        [--media-dir ".../WhatsApp Business/Media"] --out bundle
"""

import argparse
import csv
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sqlite3
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
APPLE_EPOCH = 978307200          # the Mac app counts seconds from 2001-01-01

TEXT, IMAGE, VIDEO, AUDIO, CONTACT, LOCATION, LINK, DOCUMENT, GREETING = 0, 1, 2, 3, 4, 5, 7, 8, 41
FILE_TYPES = {IMAGE: ('image', 'image/jpeg'), VIDEO: ('video', 'video/mp4'), AUDIO: ('audio', 'audio/ogg'), DOCUMENT: ('document', None)}
# Everything else is left out: system notes (10), deleted messages (14), reactions, polls and the like.


def at(apple_ts):
    return datetime.fromtimestamp(float(apple_ts) + APPLE_EPOCH, IST)


def phone_index(lid_db):
    out = {}
    con = sqlite3.connect(lid_db)
    for ident, phone in con.execute('SELECT ZIDENTIFIER, ZPHONENUMBER FROM ZWAZACCOUNT WHERE ZPHONENUMBER IS NOT NULL'):
        digits = re.sub(r'\D', '', phone or '')
        if 8 <= len(digits) <= 15:
            out[ident] = digits
            out[f'{ident}@lid'] = digits
    con.close()
    return out


def protobuf(b):
    """A protobuf message's fields as (number, value) pairs: enough to read app-state records."""
    i, out = 0, []

    def varint():
        nonlocal i
        n = shift = 0
        while True:
            c = b[i]
            i += 1
            n |= (c & 0x7f) << shift
            shift += 7
            if c < 0x80:
                return n
    while i < len(b):
        key = varint()
        field, kind = key >> 3, key & 7
        if kind == 0:
            out.append((field, varint()))
        elif kind == 2:
            n = varint()
            out.append((field, b[i:i + n]))
            i += n
        elif kind in (1, 5):
            n = 8 if kind == 1 else 4
            out.append((field, b[i:i + n]))
            i += n
        else:
            raise ValueError(f'protobuf wire type {kind}')
    return out


def from_app_state(app_db):
    """
    Labels and notes as the phone keeps them in sync with linked devices (AppState.sqlite). This
    covers every chat the phone has ever labelled, not only the chats whose messages came across.
    Returns ({jid: {label names}}, {jid: [{at, text}]}, {jid: when it was first labelled}).
    """
    labels, notes, since = {}, {}, {}
    if not app_db or not os.path.exists(app_db):
        return labels, notes, since
    con = sqlite3.connect(app_db)
    rows = con.execute('''SELECT ZACTIONNAME, CAST(ZINDEX AS TEXT), ZVALUE FROM ZAPPSTATECONFIRMEDMUTATIONENTITY
                           WHERE ZACTIONNAME IN ('label_edit', 'label_jid', 'note_edit')''').fetchall()
    con.close()
    names, links = {}, []
    for action, index, value in rows:
        index, fields = json.loads(index), protobuf(value)
        if action == 'label_edit':                                   # field 14: the label itself
            edit = dict(protobuf(next(v for f, v in fields if f == 14)))
            if not edit.get(4):                                      # 4: deleted
                names[index[1]] = edit.get(1, b'').decode().strip()
        elif action == 'label_jid':                                  # field 15: on (1) or off (0)
            if dict(protobuf(next(v for f, v in fields if f == 15))).get(1):
                links.append((index[1], index[2], dict(fields).get(1)))
        else:                                                        # field 55: the note
            note = dict(protobuf(next(v for f, v in fields if f == 55)))
            text = note.get(5, b'').decode(errors='replace').strip()
            if text and not note.get(4):
                notes.setdefault(note[2].decode(), []).append({'at': at((note.get(3) or 0) / 1000 - APPLE_EPOCH).strftime('%Y-%m-%d %H:%M:%S'), 'text': text})
    for label_id, jid, ms in links:
        if names.get(label_id):
            labels.setdefault(jid, set()).add(names[label_id])
            when = at(ms / 1000 - APPLE_EPOCH).strftime('%Y-%m-%d %H:%M:%S') if ms else None
            if when and (jid not in since or when < since[jid]):
                since[jid] = when
    for jid, ns in notes.items():
        first = min(n['at'] for n in ns)
        if jid not in since or first < since[jid]:
            since[jid] = first
    return labels, notes, since


def labels_by_jid(labels_db):
    out = {}
    if not labels_db or not os.path.exists(labels_db):
        return out
    con = sqlite3.connect(labels_db)
    for name, jid in con.execute('''SELECT l.ZNAME, p.ZCONTACTJID FROM ZWASMBLABEL l
                                      JOIN Z_1PROXIES x ON x.Z_1LABELS = l.Z_PK
                                      JOIN ZWASMBLABELEDENTITYPROXY p ON p.Z_PK = x.Z_2PROXIES
                                     WHERE p.ZCONTACTJID IS NOT NULL'''):
        out.setdefault(jid, set()).add(name)
    con.close()
    return out


class PhoneMedia:
    """The phone's media files by size, each used once: WhatsApp names them IMG-20261026-WA0012.jpg."""

    def __init__(self, root):
        self.by_size = {}
        if not root:
            return
        for base, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith('.')]          # .Links, .Statuses, …
            for f in files:
                if f.startswith('.'):
                    continue
                p = os.path.join(base, f)
                m = re.search(r'-(20\d{6})-WA', f)
                day = datetime.strptime(m.group(1), '%Y%m%d').date() if m else None
                self.by_size.setdefault(os.path.getsize(p), []).append([p, day, False])

    def take(self, size, when):
        best = None
        for c in self.by_size.get(size or -1, []):
            if c[2]:
                continue
            # Documents keep their own names, so carry no date: the exact size has to do.
            gap = abs((c[1] - when.date()).days) if c[1] else 3
            if gap <= 3 and (best is None or gap < best[0]):
                best = (gap, c)
        if not best:
            return None
        best[1][2] = True
        return best[1][0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--lid', required=True)
    ap.add_argument('--labels')
    ap.add_argument('--app-state', help='AppState.sqlite: every chat\'s labels and notes')
    ap.add_argument('--mac-media', help="the Mac app's Message folder (photos it has downloaded)")
    ap.add_argument('--media-dir', help="the phone's WhatsApp Business/Media folder")
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    phones = phone_index(args.lid)
    labels = labels_by_jid(args.labels)
    app_labels, notes, since = from_app_state(args.app_state)
    for jid, names in app_labels.items():
        labels.setdefault(jid, set()).update(names)
    phone_media = PhoneMedia(args.media_dir)
    os.makedirs(os.path.join(args.out, 'media'), exist_ok=True)
    con = sqlite3.connect(args.db)

    sessions = con.execute('SELECT Z_PK, ZCONTACTJID, ZPARTNERNAME FROM ZWACHATSESSION WHERE ZSESSIONTYPE = 0').fetchall()
    chats, skipped = [], {'no_phone': 0, 'empty': 0, 'not_one_to_one': con.execute('SELECT COUNT(*) FROM ZWACHATSESSION WHERE ZSESSIONTYPE <> 0').fetchone()[0]}
    totals = {'messages': 0, 'media': 0, 'media_from_phone': 0, 'media_missing': 0, 'labelled_without_messages': 0, 'notes': 0}
    seen = set()
    for pk, jid, partner in sessions:
        phone = phones.get(jid) or (re.sub(r'\D', '', jid.split('@')[0]) if jid and jid.endswith('@s.whatsapp.net') else None)
        if not phone:
            skipped['no_phone'] += 1
            continue
        rows = con.execute('''SELECT m.ZSTANZAID, m.ZISFROMME, m.ZMESSAGETYPE, m.ZTEXT, m.ZMESSAGEDATE,
                                     i.ZTITLE, i.ZFILESIZE, i.ZMEDIALOCALPATH, i.ZLATITUDE, i.ZLONGITUDE, i.ZVCARDNAME
                                FROM ZWAMESSAGE m LEFT JOIN ZWAMEDIAITEM i ON i.Z_PK = m.ZMEDIAITEM
                               WHERE m.ZCHATSESSION = ? ORDER BY m.ZMESSAGEDATE, m.Z_PK''', (pk,)).fetchall()
        messages = []
        for key, from_me, kind, text, date, title, size, local, lat, lng, vcard in rows:
            when = at(date)
            msg = {'at': when.strftime('%Y-%m-%d %H:%M:%S'), 'from_me': bool(from_me), 'key': key or f'mac-{pk}-{date}', 'type': 'text', 'text': ''}
            if kind in (TEXT, LINK, GREETING):
                msg['text'] = (text or '').strip()
            elif kind == LOCATION and lat is not None:
                msg['text'] = f'📍 Location: https://maps.google.com/?q={lat},{lng}'
            elif kind == CONTACT:
                msg['text'] = f'👤 Contact: {vcard or "shared a contact"}'
            elif kind in FILE_TYPES:
                ftype, mime = FILE_TYPES[kind]
                name = (title if kind == DOCUMENT else None) or (text if kind == DOCUMENT else None)
                caption = (title if kind in (IMAGE, VIDEO) else (text if kind == DOCUMENT and text != name else None)) or ''
                src = None
                if local and args.mac_media:
                    cand = os.path.join(args.mac_media, local)
                    src = cand if os.path.isfile(cand) else None
                if not src:
                    src = phone_media.take(size, when)
                    if src:
                        totals['media_from_phone'] += 1
                msg.update(type=ftype, text=caption.strip())
                if src:
                    mime = mime if kind != DOCUMENT else (mimetypes.guess_type(name or src)[0] or 'application/octet-stream')
                    ext = os.path.splitext(src)[1].lower() or (mimetypes.guess_extension(mime) or '')
                    stored = f'{hashlib.sha1(src.encode()).hexdigest()[:16]}{ext}'
                    target = os.path.join(args.out, 'media', stored)
                    if not os.path.exists(target):
                        shutil.copy2(src, target)
                    msg.update(file=f'media/{stored}', mime=mime, name=name or os.path.basename(src))
                    totals['media'] += 1
                else:
                    msg['missing'] = True
                    totals['media_missing'] += 1
            else:
                continue
            if not msg['text'] and not msg.get('file') and not msg.get('missing'):
                continue
            messages.append(msg)
        if not messages and not labels.get(jid) and not notes.get(jid):
            skipped['empty'] += 1
            continue
        seen.add(jid)
        totals['messages'] += len(messages)
        # When the chat began, as far as the phone says: its first message, label or note.
        began = min([x for x in (messages[0]['at'] if messages else None, since.get(jid)) if x], default=None)
        chats.append({'phone': phone, 'name': (partner or '').strip() or None, 'since': began,
                      'labels': sorted(labels.get(jid, [])), 'notes': notes.get(jid, []), 'messages': messages})

    # Chats the phone labelled or wrote a note on whose messages stayed on the phone.
    for jid in sorted((set(labels) | set(notes)) - seen):
        phone = phones.get(jid) or (re.sub(r'\D', '', jid.split('@')[0]) if jid.endswith('@s.whatsapp.net') else None)
        if not phone:
            skipped['no_phone'] += 1
            continue
        totals['labelled_without_messages'] += 1
        chats.append({'phone': phone, 'name': None, 'since': since.get(jid),
                      'labels': sorted(labels.get(jid, [])), 'notes': notes.get(jid, []), 'messages': []})
    totals['notes'] = sum(len(c['notes']) for c in chats)

    last = lambda c: c['messages'][-1]['at'] if c['messages'] else ''
    chats.sort(key=last, reverse=True)
    with open(os.path.join(args.out, 'chats.json'), 'w', encoding='utf-8') as f:
        json.dump({'made_at': datetime.now(IST).isoformat(), 'source': 'WhatsApp for Mac', 'chats': chats}, f, ensure_ascii=False)
    with open(os.path.join(args.out, 'chats.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['import (yes/no)', 'phone', 'name', 'labels', 'notes', 'messages', 'photos/files', 'first', 'last'])
        for c in chats:
            w.writerow(['yes', c['phone'], c['name'] or '', ', '.join(c['labels']), len(c['notes']), len(c['messages']),
                        sum(1 for m in c['messages'] if m.get('file')), c['messages'][0]['at'] if c['messages'] else '', last(c)])

    by_month = {}
    for c in chats:
        for m in c['messages']:
            by_month[m['at'][:7]] = by_month.get(m['at'][:7], 0) + 1
    by_label = {}
    for c in chats:
        for l in c['labels']:
            by_label[l] = by_label.get(l, 0) + 1
    print(json.dumps({'chats': len(chats), **totals, 'skipped': skipped, 'messages_by_month': dict(sorted(by_month.items())),
                      'labels': dict(sorted(by_label.items(), key=lambda kv: -kv[1]))}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()

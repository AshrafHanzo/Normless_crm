#!/usr/bin/env python3
"""
Turn a decrypted WhatsApp Business phone backup into an import bundle for the CRM: every one-to-one
chat's whole history, with the photos, voice notes and documents each message carries.

The backup is the one in Google Drive, downloaded and decrypted with the 64-digit key (wabdd
download / wabdd decrypt dump). Its Databases/msgstore.db holds every message, and Media/ the files,
at the paths msgstore.db names, so each file goes with its own message: nothing is guessed.

Chats are known by WhatsApp's hidden ids (…@lid); jid_map in the same database gives their phone
numbers. Labels and notes come from the Mac app's AppState.sqlite (as mac-bundle.py reads them), so
a chat imported from the Mac before keeps the same labels note; names from its ChatStorage.sqlite.

Writes the same chats.json + media/ + chats.csv as mac-bundle.py, for server/scripts/import-wa-backup.js.
Media is linked, not copied (os.link), so the bundle costs no extra disk.

    python3 -I msgstore-bundle.py --backup <decrypted backup folder> [--app-state AppState.sqlite
        --lid LID.sqlite --mac-db ChatStorage.sqlite] --out bundle
"""

import argparse
import csv
import hashlib
import importlib.util
import json
import mimetypes
import os
import re
import shutil
import sqlite3
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))

TEXT, IMAGE, AUDIO, VIDEO, CONTACT, LOCATION, DOCUMENT, GIF, STICKER, AD_REPLY = 0, 1, 2, 3, 4, 5, 9, 13, 20, 55
FILE_TYPES = {IMAGE: 'image', AUDIO: 'audio', VIDEO: 'video', DOCUMENT: 'document', GIF: 'video', STICKER: 'image'}
# Everything else is left out: system notes (7), deleted messages (15), calls, polls, reactions and the like.


def at(ms):
    return datetime.fromtimestamp(ms / 1000, IST).strftime('%Y-%m-%d %H:%M:%S')


def mac_bundle():
    """mac-bundle.py, beside this file: its reading of the Mac app's labels, notes and phone numbers."""
    spec = importlib.util.spec_from_file_location('mac_bundle', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mac-bundle.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backup', required=True, help='the decrypted backup: Databases/msgstore.db and Media/')
    ap.add_argument('--app-state', help="the Mac app's AppState.sqlite: labels and notes")
    ap.add_argument('--lid', help="the Mac app's LID.sqlite: phone numbers for AppState's ids")
    ap.add_argument('--mac-db', help="the Mac app's ChatStorage.sqlite: names")
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    os.makedirs(os.path.join(args.out, 'media'), exist_ok=True)
    con = sqlite3.connect(os.path.join(args.backup, 'Databases', 'msgstore.db'))

    # Labels, notes and names by phone, from the Mac app.
    labels, notes, since, names = {}, {}, {}, {}
    if args.app_state and args.lid:
        mb = mac_bundle()
        phones = mb.phone_index(args.lid)
        app_labels, app_notes, app_since = mb.from_app_state(args.app_state)
        for jid, ls in app_labels.items():
            if jid in phones:
                labels.setdefault(phones[jid], set()).update(ls)
        for jid, ns in app_notes.items():
            if jid in phones:
                notes.setdefault(phones[jid], []).extend(ns)
        for jid, when in app_since.items():
            if jid in phones:
                since[phones[jid]] = min(when, since.get(phones[jid], when))
        if args.mac_db:
            for jid, partner in sqlite3.connect(args.mac_db).execute('SELECT ZCONTACTJID, ZPARTNERNAME FROM ZWACHATSESSION WHERE ZSESSIONTYPE = 0'):
                name = (partner or '').strip()
                if jid in phones and re.search(r'[^\W\d_]', name):
                    names[phones[jid]] = name

    # Each one-to-one chat and its customer's number: a chat known by its LID goes through jid_map.
    chat_phone = {}
    for chat_id, raw, mapped in con.execute('''
            SELECT c._id, j.raw_string, pj.raw_string
              FROM chat c JOIN jid j ON j._id = c.jid_row_id
              LEFT JOIN jid_map m ON m.lid_row_id = j._id LEFT JOIN jid pj ON pj._id = m.jid_row_id'''):
        for candidate in (raw, mapped):
            if candidate and candidate.endswith('@s.whatsapp.net'):
                digits = re.sub(r'\D', '', candidate.split('@')[0])
                if 8 <= len(digits) <= 15:
                    chat_phone[chat_id] = digits
                    break

    rows = con.execute('''
        SELECT m.chat_row_id, m.from_me, m.key_id, m.timestamp, m.message_type, m.text_data,
               mm.file_path, mm.mime_type, mm.media_name, mm.media_caption, mm.file_size,
               l.latitude, l.longitude, l.place_name, v.vcard, ad.greeting_message_body, ad.title, mq.key_id
          FROM message m
          LEFT JOIN message_media mm ON mm.message_row_id = m._id
          LEFT JOIN message_location l ON l.message_row_id = m._id
          LEFT JOIN message_vcard v ON v.message_row_id = m._id
          LEFT JOIN message_external_ad_content ad ON ad.message_row_id = m._id
          LEFT JOIN message_quoted mq ON mq.message_row_id = m._id
         WHERE m.timestamp > 0
         ORDER BY m.chat_row_id, m.timestamp, m._id''')

    by_phone = {}
    totals = {'messages': 0, 'media': 0, 'media_missing': 0, 'ad_replies': 0}
    skipped = {'not_one_to_one': 0, 'kinds_left_out': 0}
    for (chat_id, from_me, key, ts, kind, text, fpath, mime, mname, caption, size,
         lat, lng, place, vcard, greeting, ad_title, quoted_key) in rows:
        phone = chat_phone.get(chat_id)
        if not phone:
            skipped['not_one_to_one'] += 1
            continue
        msg = {'at': at(ts), 'from_me': bool(from_me), 'key': key or f'row-{chat_id}-{ts}', 'type': 'text', 'text': ''}
        if kind == TEXT:
            msg['text'] = (text or '').strip()
        elif kind == AD_REPLY:
            # What the customer saw when they tapped the ad: its greeting, or the ad's title.
            msg['text'] = (greeting or '').strip() or (f'📣 Came from the ad: {ad_title.strip()}' if ad_title else '')
            # It carries the id and time of the customer's own first message, so it needs its own.
            msg['key'] += ':ad'
            totals['ad_replies'] += 1
        elif kind == LOCATION and lat is not None:
            msg['text'] = f'📍 {place + " — " if place else ""}Location: https://maps.google.com/?q={lat},{lng}'
        elif kind == CONTACT:
            name = re.search(r'^FN:(.*)$', vcard or '', re.M)
            msg['text'] = f'👤 Contact: {name.group(1).strip() if name else "shared a contact"}'
        elif kind in FILE_TYPES:
            msg.update(type=FILE_TYPES[kind], text=(text or caption or '').strip())
            src = os.path.join(args.backup, fpath) if fpath else None
            if src and os.path.isfile(src):
                mime = (mime or '').split(';')[0].strip() or mimetypes.guess_type(src)[0] or 'application/octet-stream'
                ext = os.path.splitext(src)[1].lower() or (mimetypes.guess_extension(mime) or '')
                stored = f'{hashlib.sha1(fpath.encode()).hexdigest()[:16]}{ext}'
                target = os.path.join(args.out, 'media', stored)
                if not os.path.exists(target):
                    try:
                        os.link(src, target)
                    except OSError:
                        shutil.copy2(src, target)
                msg.update(file=f'media/{stored}', mime=mime, name=(mname or os.path.basename(src)))
                totals['media'] += 1
            else:
                msg['missing'] = True
                totals['media_missing'] += 1
        else:
            skipped['kinds_left_out'] += 1
            continue
        if not msg['text'] and not msg.get('file') and not msg.get('missing'):
            skipped['kinds_left_out'] += 1
            continue
        if quoted_key:
            msg['reply_key'] = quoted_key          # the message this one replied to, by its WhatsApp id
            totals['replies'] = totals.get('replies', 0) + 1
        by_phone.setdefault(phone, []).append(msg)
        totals['messages'] += 1

    chats = []
    for phone in sorted(set(by_phone) | set(labels) | set(notes)):
        messages = by_phone.get(phone, [])
        began = min([x for x in (messages[0]['at'] if messages else None, since.get(phone)) if x], default=None)
        chats.append({'phone': phone, 'name': names.get(phone), 'since': began, 'labels': sorted(labels.get(phone, [])),
                      'notes': notes.get(phone, []), 'messages': messages})
    last = lambda c: c['messages'][-1]['at'] if c['messages'] else ''
    chats.sort(key=last, reverse=True)

    with open(os.path.join(args.out, 'chats.json'), 'w', encoding='utf-8') as f:
        json.dump({'made_at': datetime.now(IST).isoformat(), 'source': 'WhatsApp Business backup (Google Drive)', 'chats': chats}, f, ensure_ascii=False)
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
    print(json.dumps({'chats': len(chats), 'with_messages': sum(1 for c in chats if c['messages']), **totals, 'skipped': skipped,
                      'messages_by_month': dict(sorted(by_month.items()))}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()

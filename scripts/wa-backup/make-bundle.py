#!/usr/bin/env python3
"""
Turn a decrypted WhatsApp (Business) Android backup into an import bundle for the CRM.

Input: the JSON that WhatsApp Chat Exporter wrote (wtsexporter -a --business -j result.json ...)
and the decrypted msgstore.db it left behind (for the chats' WhatsApp labels).

Output, in the bundle folder:
  chats.json   every one-to-one chat: phone, name, labels, messages (time in India time, who sent
               it, text, the media file it carries)
  media/       the photos, videos, voice notes and documents those messages refer to
  chats.csv    one line per chat, to look through before importing (and to mark chats to leave out)

Groups, broadcast lists and status updates are left out; so are calls and system notes.

    python3 make-bundle.py --json result.json --db msgstore.db --out bundle
"""

import argparse
import csv
import hashlib
import html
import json
import mimetypes
import os
import re
import shutil
import sqlite3
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))


def at(ts):
    ts = float(ts)
    if ts > 9_999_999_999:
        ts /= 1000
    return datetime.fromtimestamp(ts, IST).strftime('%Y-%m-%d %H:%M:%S')


def plain(text):
    """The exporter's text can carry <br> and HTML escapes; WhatsApp's own text has neither."""
    if not isinstance(text, str):
        return ''
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.I)
    text = re.sub(r'<a [^>]*>(.*?)</a>', r'\1', text, flags=re.I | re.S)
    return html.unescape(text).strip()


def kind_of(mime):
    mime = mime or ''
    if mime.startswith('image/'):
        return 'image'
    if mime.startswith('video/'):
        return 'video'
    if mime.startswith('audio/'):
        return 'audio'
    return 'document'


def phone_of(jid):
    if not jid or '@' not in jid:
        return None
    user, server = jid.split('@', 1)
    if server not in ('s.whatsapp.net', 'c.us'):
        return None
    digits = re.sub(r'\D', '', user)
    return digits if 8 <= len(digits) <= 15 else None


def labels_by_phone(db_path):
    """WhatsApp Business labels per chat, by phone. Table names vary a little between versions."""
    out = {}
    if not db_path or not os.path.exists(db_path):
        return out
    con = sqlite3.connect(db_path)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    try:
        if 'labels' in tables:
            names = {r[0]: r[1] for r in con.execute('SELECT _id, label_name FROM labels')}
            link = 'labeled_jid' if 'labeled_jid' in tables else 'labeled_jids' if 'labeled_jids' in tables else None
            if link:
                cols = [r[1] for r in con.execute(f'PRAGMA table_info({link})')]
                jid_col = 'jid_row_id' if 'jid_row_id' in cols else 'jid'
                rows = con.execute(f'SELECT l.label_id, l.{jid_col} FROM {link} l')
                for label_id, jid_ref in rows:
                    raw = jid_ref
                    if jid_col == 'jid_row_id':
                        r = con.execute('SELECT raw_string FROM jid WHERE _id = ?', (jid_ref,)).fetchone()
                        raw = r[0] if r else None
                    # A chat known by its LID (newer WhatsApp) is mapped back to its phone number.
                    if raw and raw.endswith('@lid') and 'jid_map' in tables:
                        r = con.execute('''SELECT j.raw_string FROM jid l JOIN jid_map m ON m.lid_row_id = l._id
                                           JOIN jid j ON j._id = m.jid_row_id WHERE l.raw_string = ?''', (raw,)).fetchone()
                        raw = r[0] if r else raw
                    phone = phone_of(raw)
                    if phone and label_id in names:
                        out.setdefault(phone, []).append(names[label_id])
    finally:
        con.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', required=True, help="WhatsApp Chat Exporter's result.json")
    ap.add_argument('--db', help='the decrypted msgstore.db (for labels)')
    ap.add_argument('--out', required=True, help='bundle folder to write')
    args = ap.parse_args()

    with open(args.json, encoding='utf-8') as f:
        data = json.load(f)
    labels = labels_by_phone(args.db)
    os.makedirs(os.path.join(args.out, 'media'), exist_ok=True)

    chats, skipped = [], {'group_or_other': 0, 'empty': 0}
    totals = {'messages': 0, 'media': 0, 'media_missing': 0}
    for jid, chat in data.items():
        phone = phone_of(jid)
        if not phone:
            skipped['group_or_other'] += 1
            continue
        messages = []
        for mid, m in sorted((chat.get('messages') or {}).items(), key=lambda kv: float(kv[1].get('timestamp') or 0)):
            if m.get('meta'):
                if m.get('media') and m.get('data') == 'The media is missing':
                    pass                      # a file the phone no longer has: kept as a placeholder
                else:
                    continue                  # calls, system notes, deleted messages
            ts = m.get('timestamp')
            if not ts:
                continue
            msg = {'at': at(ts), 'from_me': bool(m.get('from_me')), 'key': m.get('key_id') or mid, 'type': 'text', 'text': ''}
            if m.get('media'):
                caption = plain(m.get('caption'))
                path = m.get('data') if isinstance(m.get('data'), str) else None
                mime = m.get('mime') if m.get('mime') not in (None, 'media') else None
                if path and os.path.isfile(path):
                    mime = mime or mimetypes.guess_type(path)[0] or 'application/octet-stream'
                    ext = os.path.splitext(path)[1].lower() or (mimetypes.guess_extension(mime) or '')
                    digest = hashlib.sha1(path.encode('utf-8')).hexdigest()[:16]
                    name = f'{digest}{ext}'
                    target = os.path.join(args.out, 'media', name)
                    if not os.path.exists(target):
                        shutil.copy2(path, target)
                    msg.update(type=kind_of(mime), text=caption, file=f'media/{name}', mime=mime, name=os.path.basename(path))
                    totals['media'] += 1
                else:
                    msg.update(type=kind_of(mime or 'image/'), text=caption, missing=True)
                    totals['media_missing'] += 1
            else:
                msg['text'] = plain(m.get('data'))
                if not msg['text']:
                    continue
            messages.append(msg)
        if not messages:
            skipped['empty'] += 1
            continue
        totals['messages'] += len(messages)
        chats.append({
            'phone': phone, 'name': (chat.get('name') or '').strip() or None,
            'labels': sorted(set(labels.get(phone, []))), 'messages': messages,
        })

    chats.sort(key=lambda c: c['messages'][-1]['at'], reverse=True)
    with open(os.path.join(args.out, 'chats.json'), 'w', encoding='utf-8') as f:
        json.dump({'made_at': datetime.now(IST).isoformat(), 'chats': chats}, f, ensure_ascii=False)
    with open(os.path.join(args.out, 'chats.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['import (yes/no)', 'phone', 'name', 'labels', 'messages', 'photos/files', 'first', 'last'])
        for c in chats:
            files = sum(1 for m in c['messages'] if m.get('file'))
            w.writerow(['yes', c['phone'], c['name'] or '', ', '.join(c['labels']), len(c['messages']), files,
                        c['messages'][0]['at'], c['messages'][-1]['at']])

    all_labels = {}
    for c in chats:
        for l in c['labels']:
            all_labels[l] = all_labels.get(l, 0) + 1
    print(json.dumps({'chats': len(chats), **totals, 'skipped': skipped, 'labels': all_labels}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
The WhatsApp names and profile photos the Mac app (linked to the number) knows, by phone number:
profiles.json + photos/, for server/scripts/import-wa-profiles.js.

A name is what the customer set on WhatsApp (their "push name"). A photo is the small copy the app
keeps of each contact it has shown; the Cloud API gives neither, so this is the only source.

    python3 -I mac-profiles.py --db ChatStorage.sqlite --lid LID.sqlite
        --profile-dir "~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared" --out profiles
"""

import argparse
import json
import os
import re
import shutil
import sqlite3


def phone_of(jid, phones):
    if not jid:
        return None
    if jid.endswith('@s.whatsapp.net'):
        digits = re.sub(r'\D', '', jid.split('@')[0])
        return digits if 8 <= len(digits) <= 15 else None
    return phones.get(jid)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True, help="the Mac app's ChatStorage.sqlite")
    ap.add_argument('--lid', required=True, help="the Mac app's LID.sqlite")
    ap.add_argument('--profile-dir', required=True, help='the app container, which holds Media/Profile')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    phones = {}
    for ident, phone in sqlite3.connect(args.lid).execute('SELECT ZIDENTIFIER, ZPHONENUMBER FROM ZWAZACCOUNT WHERE ZPHONENUMBER IS NOT NULL'):
        digits = re.sub(r'\D', '', phone or '')
        if 8 <= len(digits) <= 15:
            phones[ident if '@' in ident else f'{ident}@lid'] = digits

    con = sqlite3.connect(args.db)
    out = {}
    for jid, name in con.execute('SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME'):
        phone, name = phone_of(jid, phones), (name or '').strip()
        if phone and re.search(r'[^\W\d_]', name):
            out.setdefault(phone, {})['name'] = name

    os.makedirs(os.path.join(args.out, 'photos'), exist_ok=True)
    for jid, path in con.execute('SELECT ZJID, ZPATH FROM ZWAPROFILEPICTUREITEM WHERE ZPATH IS NOT NULL'):
        phone = phone_of(jid, phones)
        src = next((p for p in (os.path.join(args.profile_dir, path + '.thumb'), os.path.join(args.profile_dir, path)) if os.path.isfile(p)), None)
        if phone and src:
            shutil.copy2(src, os.path.join(args.out, 'photos', f'{phone}.jpg'))
            out.setdefault(phone, {})['photo'] = f'photos/{phone}.jpg'

    with open(os.path.join(args.out, 'profiles.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    print(json.dumps({'people': len(out), 'names': sum('name' in v for v in out.values()), 'photos': sum('photo' in v for v in out.values())}))


if __name__ == '__main__':
    main()

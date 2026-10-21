#!/usr/bin/env python3
"""
App Store Connect steps after an upload, with the API key in ~/.appstoreconnect (see
ship-testflight.sh). Idempotent: running it twice changes nothing the second time.

  asc_testflight.py publish <build number> <whats-new file> [--group Public] [--keep-old]
  asc_testflight.py has <build number>        # exit 0 if that build was already uploaded
"""
import os, sys, time
import jwt, requests

BASE = 'https://api.appstoreconnect.apple.com'
APP_ID = '6818585201'   # ViibeMeter, pinned in eas.json
HOME = os.path.expanduser('~/.appstoreconnect')

env = dict(l.strip().split('=', 1) for l in open(f'{HOME}/viibe.env') if '=' in l)
KEY = open(f'{HOME}/AuthKey.p8').read()


def token():
    now = int(time.time())
    return jwt.encode({'iss': env['ISSUER_ID'], 'iat': now, 'exp': now + 900, 'aud': 'appstoreconnect-v1'},
                      KEY, algorithm='ES256', headers={'kid': env['KEY_ID']})


def call(method, path, **kw):
    r = requests.request(method, BASE + path, headers={'Authorization': f'Bearer {token()}', 'Content-Type': 'application/json'}, **kw)
    return r


def get(path, **params):
    r = call('GET', path, params=params)
    r.raise_for_status()
    return r.json()


def find_build(number):
    d = get('/v1/builds', **{'filter[app]': APP_ID, 'filter[version]': str(number), 'fields[builds]': 'version,processingState,expired'})
    return d['data'][0] if d['data'] else None


def publish(number, whats_new_file, group_name='Public', expire_old=True):
    text = open(whats_new_file).read().strip()
    # 1. wait until Apple has processed the upload
    for _ in range(60):
        b = find_build(number)
        if b and b['attributes']['processingState'] == 'VALID':
            break
        print(f'Waiting for Apple to process build {number}…')
        time.sleep(30)
    else:
        sys.exit(f'Build {number} was not processed in 30 minutes.')
    bid = b['id']

    # 2. "What to Test" (no emoji: Apple rejects them here)
    locs = get(f'/v1/builds/{bid}/betaBuildLocalizations')['data']
    if locs:
        r = call('PATCH', f"/v1/betaBuildLocalizations/{locs[0]['id']}", json={'data': {'type': 'betaBuildLocalizations', 'id': locs[0]['id'], 'attributes': {'whatsNew': text}}})
    else:
        r = call('POST', '/v1/betaBuildLocalizations', json={'data': {'type': 'betaBuildLocalizations', 'attributes': {'locale': 'en-US', 'whatsNew': text}, 'relationships': {'build': {'data': {'type': 'builds', 'id': bid}}}}})
    if r.status_code >= 300:
        sys.exit(f'Could not set What to Test: {r.text[:300]}')
    print('What to Test saved.')

    # 3. add to the group
    groups = get(f'/v1/apps/{APP_ID}/betaGroups')['data']
    gid = next((g['id'] for g in groups if g['attributes']['name'] == group_name), None)
    if not gid:
        sys.exit(f'No TestFlight group named {group_name}.')
    r = call('POST', f'/v1/betaGroups/{gid}/relationships/builds', json={'data': [{'type': 'builds', 'id': bid}]})
    print(f'Added to {group_name}.' if r.status_code < 300 else f'Group: {r.text[:200]}')

    # 4. beta review (a no-op error if it was already submitted)
    r = call('POST', '/v1/betaAppReviewSubmissions', json={'data': {'type': 'betaAppReviewSubmissions', 'relationships': {'build': {'data': {'type': 'builds', 'id': bid}}}}})
    state = get(f'/v1/builds/{bid}/buildBetaDetail')['data']['attributes']['externalBuildState']
    print(f'External testers: {state}.')

    # 5. expire older builds in the group, but only once this one is available to testers
    if expire_old and state == 'IN_BETA_TESTING':
        for old in get(f'/v1/betaGroups/{gid}/builds', **{'fields[builds]': 'version,expired', 'limit': 50})['data']:
            if int(old['attributes']['version']) < int(number) and not old['attributes']['expired']:
                call('PATCH', f"/v1/builds/{old['id']}", json={'data': {'type': 'builds', 'id': old['id'], 'attributes': {'expired': True}}})
                print(f"Expired build {old['attributes']['version']}.")
    elif expire_old:
        print('Older builds kept until this one is approved: run this again then.')


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'has':
        sys.exit(0 if find_build(sys.argv[2]) else 1)
    if cmd == 'publish':
        args = sys.argv[2:]
        group = args[args.index('--group') + 1] if '--group' in args else 'Public'
        publish(args[0], args[1], group, expire_old='--keep-old' not in args)

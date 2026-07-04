#!/usr/bin/env python3
"""ADM-D acceptance (v2 blueprint work item 18 / admission design §7.3, C10):
a real `garden.admission.evaluated.v1` envelope with `data.language === 'glsl'`
must validate against nervous-bus's `shader.preadmit.evaluated.v1` schema after
stripping the browser-only keys named in admission design §7.3
(surface, backend, stages, compile_log, preview_png).

READ ONLY against nervous-bus — this script never writes there; the operator
files the schema bump ecosystem-side (docs/proposals/preadmit-v2.md, this repo).

Usage: check_preadmit_v1_compat.py <envelope.json> [--schema PATH]
The default schema path assumes a sibling nervous-bus checkout ($NBUS_ROOT
overrides). Missing schema = "SKIP" + exit 0, so a clone of this repo alone
still runs the full suite; the check only bites where the ecosystem exists.
Exit 0 + "OK: ..." on success; non-zero + jsonschema's own error on failure.
"""
import argparse
import os
import json
import sys

import jsonschema

DEFAULT_SCHEMA = os.path.join(
    os.environ.get('NBUS_ROOT', os.path.expanduser('~/projects/nervous-bus')),
    'schemas', 'shader.preadmit.evaluated.v1.json')
BROWSER_ONLY_KEYS = ('surface', 'backend', 'stages', 'compile_log', 'preview_png')


def to_preadmit_v1(envelope):
    """The ~40-line operator-bridge conversion (admission design §7.3),
    reduced to its schema-relevant core: re-emit as shader.preadmit.evaluated.v1
    verbatim after stripping the browser-only keys. Every remaining key/enum
    is valid v1 by construction — admission's AdmissionReport (§4.2)
    deliberately reuses only v1 render_metrics names."""
    data = {k: v for k, v in envelope['data'].items() if k not in BROWSER_ONLY_KEYS}
    return {
        'specversion': envelope['specversion'],
        'id': envelope['id'],
        'source': '/autobench/pre_admit',  # schema pins this const — the bridge's own emission identity, not garden's
        'type': 'shader.preadmit.evaluated.v1',
        'datacontenttype': envelope['datacontenttype'],
        'time': envelope['time'],
        'data': data,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('envelope', help='path to a captured garden.admission.evaluated.v1 envelope (JSON)')
    ap.add_argument('--schema', default=DEFAULT_SCHEMA)
    args = ap.parse_args()

    envelope = json.load(open(args.envelope))
    language = envelope.get('data', {}).get('language')
    if language != 'glsl':
        print(f'SKIP: envelope language is {language!r}, not glsl — wgsl is held for preadmit.v2 (C10), not converted here')
        return 0

    converted = to_preadmit_v1(envelope)
    if not os.path.exists(args.schema):
        print(f'SKIP: schema not found at {args.schema} — no nervous-bus checkout; '
              'set NBUS_ROOT or pass --schema to run the real check')
        return 0
    schema = json.load(open(args.schema))
    jsonschema.Draft202012Validator(schema).validate(converted)
    print('OK: glsl garden.admission.evaluated.v1 envelope validates against '
          'shader.preadmit.evaluated.v1 after stripping ' + ', '.join(BROWSER_ONLY_KEYS))
    return 0


if __name__ == '__main__':
    sys.exit(main())

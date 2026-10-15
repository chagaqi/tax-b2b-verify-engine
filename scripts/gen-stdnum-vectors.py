#!/usr/bin/env python3
"""Generate cross-validation vectors for the TypeScript tax-ID engine.

Uses python-stdnum (https://arthurdejong.org/python-stdnum/) as an
independent reference implementation. For each jurisdiction we draw random
numbers of the right *shape*, then enumerate the check position(s) so the
fixture contains both checksum-valid and checksum-invalid neighbours.

    python3 -m venv .venv && .venv/bin/pip install python-stdnum
    .venv/bin/python scripts/gen-stdnum-vectors.py > packages/core-api/test/fixtures/stdnum-vectors.json

Seeded, so the output is reproducible for a given stdnum version.
"""
import datetime
import importlib
import itertools
import json
import random
import string
import sys

import stdnum

rng = random.Random(20261015)
D = string.digits
U = string.ascii_uppercase
PER_KIND = 12  # valid and invalid vectors per (jurisdiction, shape)


def digits(n):
    return ''.join(rng.choice(D) for _ in range(n))


def rdate(start=1930, end=2020):
    d = datetime.date(start, 1, 1) + datetime.timedelta(days=rng.randrange((end - start) * 365))
    return d


def enum_check(make, pos, length, alphabet):
    """make() -> template string; overwrite [pos:pos+length] with all combos."""
    def gen():
        t = make()
        p = pos if pos >= 0 else len(t) + pos  # negative = count from the end
        combos = [''.join(c) for c in itertools.product(alphabet, repeat=length)]
        return [t[:p] + c + t[p + length:] for c in combos]
    return gen


def plain(make):
    return lambda: [make()]


def cz_rc():
    d = rdate(1954, 2020)
    m = d.month + rng.choice([0, 50])
    return f'{d.year % 100:02d}{m:02d}{d.day:02d}' + digits(4)


def ro_cnp():
    d = rdate(1950, 2005)
    s = '1' if d.year < 2000 else '5'
    return s + f'{d.year % 100:02d}{d.month:02d}{d.day:02d}' + digits(6)


def lv_pers():
    d = rdate(1900, 2010)
    return f'{d.day:02d}{d.month:02d}{d.year % 100:02d}' + str((d.year - 1800) // 100) + digits(4)


def mx_rfc(company):
    d = rdate(2000, 2030)
    head = ''.join(rng.choice(U) for _ in range(3 if company else 4))
    return head + f'{d.year % 100:02d}{d.month:02d}{d.day:02d}' + rng.choice('123456789ABCDEFGHIJKLMNPQRSTUV') + rng.choice('123456789ABCDEFGHIJKLMNPQRSTUVWXYZ') + rng.choice(D + 'A')


SG_TYPES = ['LP', 'LL', 'FC', 'PF', 'RF', 'MQ', 'CC', 'SS']

# code -> (stdnum module, [generators])
SPECS = {
    'AT': ('at.uid', [enum_check(lambda: 'U' + digits(8), 8, 1, D)]),
    'BE': ('be.vat', [enum_check(lambda: rng.choice('01') + digits(9), 8, 2, D)]),
    'BG': ('bg.vat', [enum_check(lambda: digits(9), 8, 1, D), enum_check(lambda: digits(10), 9, 1, D)]),
    'CY': ('cy.vat', [enum_check(lambda: rng.choice('0134559') + digits(7) + 'A', 8, 1, U)]),
    'CZ': ('cz.dic', [enum_check(lambda: rng.choice('12345678') + digits(7), 7, 1, D),
                      enum_check(cz_rc, 9, 1, D),
                      enum_check(lambda: '6' + digits(8), 8, 1, D)]),
    'DE': ('de.vat', [enum_check(lambda: rng.choice('123456789') + digits(8), 8, 1, D)]),
    'DK': ('dk.cvr', [enum_check(lambda: rng.choice('123456789') + digits(7), 7, 1, D)]),
    'EE': ('ee.kmkr', [enum_check(lambda: '10' + digits(7), 8, 1, D)]),
    'GR': ('gr.vat', [enum_check(lambda: digits(9), 8, 1, D)]),
    'ES': ('es.nif', [enum_check(lambda: digits(8) + 'A', 8, 1, U),
                      enum_check(lambda: rng.choice('XYZ') + digits(7) + 'A', 8, 1, U),
                      enum_check(lambda: rng.choice('ABCDEFGHJNPQRSUVW') + digits(7) + '0', 8, 1, D + 'ABCDEFGHIJ'),
                      enum_check(lambda: rng.choice('KLM') + digits(7) + 'A', 8, 1, U)]),
    'FI': ('fi.alv', [enum_check(lambda: digits(8), 7, 1, D)]),
    'FR': ('fr.tva', [enum_check(lambda: '00' + digits(9), 0, 2, D),
                      enum_check(lambda: 'AA' + digits(9), 0, 2, '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ')]),
    'HR': ('hr.oib', [enum_check(lambda: digits(11), 10, 1, D)]),
    'HU': ('hu.anum', [enum_check(lambda: digits(8), 7, 1, D)]),
    'IE': ('ie.vat', [enum_check(lambda: digits(7) + 'A', 7, 1, 'WABCDEFGHIJKLMNOPQRSTUV'),
                      enum_check(lambda: digits(7) + 'AH', 7, 1, 'WABCDEFGHIJKLMNOPQRSTUV'),
                      enum_check(lambda: rng.choice(D) + rng.choice(U + '+*') + digits(5) + 'A', 7, 1, 'WABCDEFGHIJKLMNOPQRSTUV')]),
    'IT': ('it.iva', [enum_check(lambda: digits(7) + rng.choice(['001', '015', '058', '100', '120', '888', '999', '250']) + '0', 10, 1, D)]),
    'LT': ('lt.pvm', [enum_check(lambda: digits(7) + '10', 8, 1, D), enum_check(lambda: digits(10) + '10', 11, 1, D)]),
    'LU': ('lu.tva', [enum_check(lambda: digits(8), 6, 2, D)]),
    'LV': ('lv.pvn', [enum_check(lambda: rng.choice('456789') + digits(10), 10, 1, D),
                      enum_check(lambda: '32' + digits(9), 10, 1, D),
                      enum_check(lv_pers, 10, 1, D)]),
    'MT': ('mt.vat', [enum_check(lambda: rng.choice('123456789') + digits(7), 7, 1, D)]),
    'NL': ('nl.btw', [enum_check(lambda: digits(9) + 'B' + rng.choice(['01', '02', '17']), 8, 1, D)]),
    'PL': ('pl.nip', [enum_check(lambda: digits(10), 9, 1, D)]),
    'PT': ('pt.nif', [enum_check(lambda: rng.choice('123456789') + digits(8), 8, 1, D)]),
    'RO': ('ro.cf', [enum_check(lambda: rng.choice('123456789') + digits(rng.randint(1, 9)), -1, 1, D),
                     enum_check(ro_cnp, 12, 1, D)]),
    'SE': ('se.vat', [enum_check(lambda: digits(10) + '01', 9, 1, D)]),
    'SI': ('si.ddv', [enum_check(lambda: rng.choice('123456789') + digits(7), 7, 1, D)]),
    'SK': ('sk.dph', [enum_check(lambda: rng.choice('123456789') + digits(1) + rng.choice('234789') + digits(7), 9, 1, D),
                      enum_check(cz_rc, 9, 1, D)]),
    'XI': ('gb.vat', [enum_check(lambda: rng.choice('123456789') + digits(8), 7, 2, D)]),
    'GB': ('gb.vat', [enum_check(lambda: rng.choice('123456789') + digits(8), 7, 2, D),
                      enum_check(lambda: '0' + digits(8), 7, 2, D),
                      enum_check(lambda: rng.choice('123456789') + digits(8) + digits(3), 7, 2, D)]),
    'US': ('us.ein', [plain(lambda: digits(9))]),
    'CA': ('ca.bn', [enum_check(lambda: digits(9), 8, 1, D),
                     enum_check(lambda: digits(9) + rng.choice(['RC', 'RM', 'RP', 'RT']) + digits(4), 8, 1, D)]),
    'AU': ('au.abn', [enum_check(lambda: digits(11), 0, 2, D)]),
    'AU_ACN': ('au.acn', [enum_check(lambda: digits(9), 8, 1, D)]),
    'IN': ('in_.gstin', [enum_check(lambda: f'{rng.randint(1, 37):02d}' + ''.join(rng.choice(U) for _ in range(3)) + rng.choice('ABCFGHLJPT') + rng.choice(U) + digits(4) + rng.choice(U) + rng.choice('123456789ABC') + 'Z0', 14, 1, D + U)]),
    'CH': ('ch.uid', [enum_check(lambda: 'CHE' + digits(9), 11, 1, D)]),
    'NO': ('no.orgnr', [enum_check(lambda: digits(9), 8, 1, D)]),
    'NZ': ('nz.ird', [enum_check(lambda: rng.choice(['1', '2', '4', '7', '9']) + digits(7), 7, 1, D),
                      enum_check(lambda: '1' + rng.choice('01234') + digits(7), 8, 1, D)]),
    'BR': ('br.cnpj', [enum_check(lambda: digits(14), 12, 2, D)]),
    'MX': ('mx.rfc', [plain(lambda: mx_rfc(True)), plain(lambda: mx_rfc(False))]),
    'JP': ('jp.cn', [enum_check(lambda: digits(13), 0, 1, D)]),
    'SG': ('sg.uen', [enum_check(lambda: digits(8) + 'A', 8, 1, U),
                      enum_check(lambda: str(rng.randint(1970, 2025)) + digits(5) + 'A', 9, 1, U),
                      enum_check(lambda: rng.choice('ST') + f'{rng.randint(0, 25):02d}' + rng.choice(SG_TYPES) + digits(4) + 'A', 9, 1, 'ABCDEFGHJKLMNPQRSTUVWX0123456789')]),
    'KR': ('kr.brn', [plain(lambda: digits(10))]),
    'RU': ('ru.inn', [enum_check(lambda: digits(10), 9, 1, D), enum_check(lambda: digits(12), 10, 2, D)]),
    'TR': ('tr.vkn', [enum_check(lambda: digits(10), 9, 1, D)]),
    'AR': ('ar.cuit', [enum_check(lambda: rng.choice(['20', '23', '27', '30', '33', '50']) + digits(9), 10, 1, D)]),
    'CL': ('cl.rut', [enum_check(lambda: digits(rng.choice([7, 8])) + '0', -1, 1, D + 'K')]),
    'CO': ('co.nit', [enum_check(lambda: digits(rng.randint(8, 15)), -1, 1, D)]),
}


def main():
    out = {'generator': 'python-stdnum', 'stdnumVersion': stdnum.__version__, 'vectors': []}
    for code, (modname, gens) in SPECS.items():
        mod = importlib.import_module('stdnum.' + modname)
        country = 'AU' if code == 'AU_ACN' else code
        for gen in gens:
            valid, invalid = set(), set()
            tries = 0
            while (len(valid) < PER_KIND or len(invalid) < PER_KIND) and tries < 20000:
                tries += 1
                for c in gen():
                    ok = mod.is_valid(c)
                    (valid if ok else invalid).add(c)
            for c in sorted(valid)[:PER_KIND]:
                out['vectors'].append({'country': country, 'input': c, 'valid': True})
            invalid_sorted = sorted(invalid)
            rng.shuffle(invalid_sorted)  # spread across check values, deterministically
            for c in invalid_sorted[:PER_KIND]:
                out['vectors'].append({'country': country, 'input': c, 'valid': False})
    json.dump(out, sys.stdout, indent=0, ensure_ascii=False)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()

"""Check a layered-summary JSON file (one object, or a list of objects).

Usage: python check_summary.py FILE.json [--source DOC.md] [--langs en,ru]

Checks per language: gist <= 25 words; 3-5 glance bullets of <= 30 words;
3-6 detail sections with a heading and non-empty paragraphs; all languages
have the same number of bullets and sections and the same numbers in each
layer. With --source, every number in the first language must appear in the
source. Exit code 1 if any error.
"""
import json, re, sys

# A numeral with optional thousands groups (comma, space or no-break space) and an optional decimal part,
# normalised so 11,196 (English) == 11 196 (Russian) and 36.5 == 36,5.
NUM = re.compile(r'(?<![\w.,])\d{1,3}(?:(?:,|[ \u00a0])\d{3})+(?:[.,]\d+)?(?![\d])|(?<![\w.])\d+(?:[.,]\d+)?')


def norm(tok):
    if re.match(r'^\d{1,3}(,\d{3})+(\.\d+)?$', tok) and not tok.startswith('0,'):
        return tok.replace(',', '')
    if re.match(r'^\d{1,3}([ \u00a0]\d{3})+(,\d+)?$', tok):
        return tok.replace(' ', '').replace('\u00a0', '').replace(',', '.')
    return tok.replace(',', '.')


def nums(text):
    return sorted(norm(n) for n in NUM.findall(text))


def words(s):
    return len(s.split())


def check(obj, langs, source, errs):
    sid = obj.get('id', '?')
    def err(m): errs.append('%s: %s' % (sid, m))
    for L in langs:
        v = obj.get(L)
        if not isinstance(v, dict): err('missing language %s' % L); return
        if not v.get('gist', '').strip(): err('%s gist empty' % L)
        elif words(v['gist']) > 25 and L == langs[0]: err('%s gist has %d words (max 25)' % (L, words(v['gist'])))
        g = v.get('glance', [])
        if not 3 <= len(g) <= 5: err('%s glance has %d bullets (3-5)' % (L, len(g)))
        for i, b in enumerate(g):
            if not b.strip(): err('%s glance %d empty' % (L, i))
            elif words(b) > 30 and L == langs[0]: err('%s glance %d has %d words (max 30)' % (L, i, words(b)))
        d = v.get('detail', [])
        if not 3 <= len(d) <= 6: err('%s detail has %d sections (3-6)' % (L, len(d)))
        for i, s in enumerate(d):
            if not s.get('h', '').strip() or not s.get('p') or not all(p.strip() for p in s['p']):
                err('%s detail %d needs a heading and non-empty paragraphs' % (L, i))
    if errs and any(e.startswith(sid + ': missing') for e in errs): return
    base = obj[langs[0]]
    for L in langs[1:]:
        o = obj[L]
        if len(o.get('glance', [])) != len(base.get('glance', [])): err('%s has a different number of glance bullets' % L)
        if len(o.get('detail', [])) != len(base.get('detail', [])): err('%s has a different number of detail sections' % L)
        layers = [('gist', base.get('gist', ''), o.get('gist', ''))]
        layers += [('glance %d' % i, a, b) for i, (a, b) in enumerate(zip(base.get('glance', []), o.get('glance', [])))]
        layers += [('detail %d' % i, json.dumps(a, ensure_ascii=False), json.dumps(b, ensure_ascii=False))
                   for i, (a, b) in enumerate(zip(base.get('detail', []), o.get('detail', [])))]
        for name, a, b in layers:
            if nums(a) != nums(b): err('%s %s numbers differ: %s vs %s' % (L, name, nums(a), nums(b)))
    if source is not None:
        src = set(norm(n) for n in NUM.findall(source))
        allv = json.dumps(base, ensure_ascii=False)
        for n in sorted(set(nums(allv))):
            if n not in src: err('number %s is not in the source' % n)


def main(argv):
    if len(argv) < 2: print(__doc__); return 2
    path, source, langs = argv[1], None, ['en', 'ru']
    if '--source' in argv: source = open(argv[argv.index('--source') + 1], encoding='utf-8').read()
    if '--langs' in argv: langs = argv[argv.index('--langs') + 1].split(',')
    data = json.load(open(path, encoding='utf-8'))
    items = data if isinstance(data, list) else [data]
    errs = []
    for obj in items: check(obj, langs, source, errs)
    for e in errs: print('ERROR ' + e)
    print('%d checked, %d errors' % (len(items), len(errs)))
    return 1 if errs else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))

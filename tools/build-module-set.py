#!/usr/bin/env python3
"""Build a Scransible module set from `ansible-doc`.

Usage:
    python3 tools/build-module-set.py tools/module-sets/cisco.ios.json > modules/cisco.ios.js

The spec file names the collection and, for each module, its palette category,
the arguments shown on the block itself ("palette") and any default values a new
block starts with. Everything else (argument types, choices, required flags,
aliases, descriptions) comes from `ansible-doc -j`, so the collection must be
installed where ansible-doc can find it (ANSIBLE_COLLECTIONS_PATH).

The output is strict JSON inside a single `Scransible.registerModuleSet(...)`
call, so the app can load it as a script or import it as data without running it.
"""
import json
import subprocess
import sys


def kind_of(option):
    """Map an ansible-doc option to the builder's argument kinds."""
    t = option.get('type', 'str')
    elements = option.get('elements')
    if t == 'bool':
        return 'bool'
    if t == 'list' and (elements in (None, 'str', 'raw', 'path') or option.get('choices')):
        return 'list'
    if t in ('list', 'dict', 'json', 'jsonarg'):
        return 'yaml'
    if option.get('choices'):
        return 'choice'
    if t in ('int', 'float'):
        return 'int'
    return 'str'


def arg_spec(option):
    spec = {'kind': kind_of(option)}
    if option.get('required'):
        spec['required'] = True
    if option.get('aliases'):
        spec['aliases'] = option['aliases']
    if spec['kind'] == 'choice':
        spec['choices'] = [str(c) for c in option['choices']]
    if spec['kind'] in ('bool', 'choice') and option.get('default') is not None:
        spec['default'] = option['default'] if spec['kind'] == 'bool' else str(option['default'])
    if spec['kind'] == 'yaml':
        spec['empty'] = [] if option.get('type') == 'list' else {}
    description = option.get('description')
    if isinstance(description, list):
        description = ' '.join(description)
    if description:
        spec['doc'] = description.split('. ')[0].strip().rstrip('.')[:160]
    return spec


def module_entry(collection, short, spec):
    fqcn = f'{collection}.{short}'
    result = subprocess.run(['ansible-doc', '-j', fqcn], capture_output=True, text=True, check=True)
    doc = json.loads(result.stdout)[fqcn]['doc']
    options = doc.get('options') or {}
    args = {}
    for name, option in sorted(options.items(), key=lambda kv: (not kv[1].get('required'), kv[0])):
        if name == 'free_form':
            free = arg_spec(option)
            free.pop('required', None)
            args['_raw'] = free
        else:
            args[name] = arg_spec(option)
    entry = {
        'name': fqcn,
        'short': short,
        'category': spec['category'],
        'description': doc.get('short_description', '').strip().rstrip('.'),
        'palette': spec.get('palette', []),
    }
    for key in ('label', 'defaults', 'freeArgs'):
        if key in spec:
            entry[key] = spec[key]
    for name in entry['palette'] + list(entry.get('defaults', {})):
        if name not in args and not entry.get('freeArgs'):
            sys.exit(f'{fqcn}: "{name}" is not a documented option')
    entry['args'] = args
    return entry


def dump(module_set):
    """JSON with one line per argument, so the files stay readable and diffable."""
    lines = ['{']
    head = {k: v for k, v in module_set.items() if k != 'modules'}
    for key, value in head.items():
        lines.append(f'  {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)},')
    lines.append('  "modules": [')
    for i, module in enumerate(module_set['modules']):
        lines.append('    {')
        fields = [(k, v) for k, v in module.items() if k != 'args']
        for key, value in fields:
            lines.append(f'      {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)},')
        lines.append('      "args": {')
        arg_items = list(module['args'].items())
        for j, (name, spec) in enumerate(arg_items):
            comma = ',' if j < len(arg_items) - 1 else ''
            lines.append(f'        {json.dumps(name)}: {json.dumps(spec, ensure_ascii=False)}{comma}')
        lines.append('      }')
        lines.append('    }' + (',' if i < len(module_set['modules']) - 1 else ''))
    lines.append('  ]')
    lines.append('}')
    return '\n'.join(lines)


def collection_version(collection):
    if collection == 'ansible.builtin':
        out = subprocess.run(['ansible-doc', '--version'], capture_output=True, text=True).stdout
        return out.split('\n')[0].split('core ')[-1].strip(' ]')
    out = subprocess.run(['ansible-galaxy', 'collection', 'list', collection, '--format', 'json'], capture_output=True, text=True).stdout
    for paths in json.loads(out or '{}').values():
        if collection in paths:
            return paths[collection]['version']
    return ''


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    spec = json.load(open(sys.argv[1]))
    collection = spec['collection']
    module_set = {
        'collection': collection,
        'title': spec.get('title', collection),
        'version': collection_version(collection),
    }
    if spec.get('categories'):
        module_set['categories'] = spec['categories']
    module_set['modules'] = [module_entry(collection, short, m) for short, m in spec['modules'].items()]
    print(f'// Generated by tools/build-module-set.py from {sys.argv[1]} and ansible-doc.')
    print('// Edit the spec and regenerate rather than changing this file by hand.')
    print(f'Scransible.registerModuleSet({dump(module_set)});')


if __name__ == '__main__':
    main()

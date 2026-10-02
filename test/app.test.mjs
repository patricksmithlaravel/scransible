import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jsdom from 'jsdom';

const { JSDOM, requestInterceptor } = jsdom;
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const jsYamlSource = readFileSync(join(root, 'node_modules/js-yaml/dist/js-yaml.min.js'));
const plain = value => JSON.parse(JSON.stringify(value));
const hasCommand = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const hasPyYaml = hasCommand('python3', ['-c', 'import yaml']);
const hasAnsible = hasCommand('ansible-playbook', ['--version']);
const hasAnsibleDoc = hasCommand('ansible-doc', ['--version']);

// The app is served from a made-up http origin (so localStorage works), with its files
// read from disk and js-yaml from node_modules (the page loads it from cdnjs); fonts and
// anything else external are answered empty.
const ORIGIN = 'http://scransible.test/';
const localFiles = requestInterceptor(request => {
  if (request.url.includes('js-yaml')) return new Response(jsYamlSource, { headers: { 'Content-Type': 'application/javascript' } });
  if (request.url.startsWith(ORIGIN)) {
    const path = join(root, decodeURIComponent(new URL(request.url).pathname));
    const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/javascript';
    return new Response(readFileSync(path), { headers: { 'Content-Type': type } });
  }
  return new Response('', { headers: { 'Content-Type': 'text/css' } });
});

async function openApp({ hash = '#/builder', project, legacy } = {}) {
  const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'), {
    url: `${ORIGIN}index.html${hash}`,
    runScripts: 'dangerously',
    resources: { interceptors: [localFiles] },
    pretendToBeVisual: true,
    beforeParse(window) {
      window.structuredClone = structuredClone;
      window.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };
      Object.assign(window, { Blob, Response, CompressionStream, DecompressionStream, TextEncoder, TextDecoder });
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
      if (project) window.localStorage.setItem('scransible.project', JSON.stringify(project));
      if (legacy) window.localStorage.setItem('ansiblePlaybookBuilderState', JSON.stringify(legacy));
    }
  });
  const { window } = dom;
  for (let i = 0; i < 200 && !(window.Scransible?.store?.project && window.document.querySelector('.topbar a')); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(window.Scransible?.store?.project, 'the app booted');
  return { window, SX: window.Scransible, doc: window.document };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('every bundled module set loads and is plain data', async () => {
  const { SX } = await openApp();
  const files = readdirSync(join(root, 'modules')).filter(f => f !== 'index.js');
  assert.deepEqual(plain(SX.moduleSetFiles).sort(), files.sort(), 'modules/index.js lists every module set file');
  assert.equal(SX.moduleSets.length, files.length);
  for (const file of files) {
    const set = SX.parseModuleSetText(readFileSync(join(root, 'modules', file), 'utf8'));
    assert.ok(set.modules.length, `${file} has modules`);
    for (const module of set.modules) {
      for (const name of [...module.palette, ...Object.keys(module.defaults || {})]) {
        if (module.freeArgs) continue;
        assert.ok(module.args[name], `${module.name}: "${name}" is a documented argument`);
      }
      assert.ok(SX.categories.some(c => c.id === module.category), `${module.name} has a known category`);
    }
  }
});

test('a module set can be added in the app and removed again', async () => {
  const { SX } = await openApp();
  const text = `Scransible.registerModuleSet(${JSON.stringify({
    collection: 'acme.internal', title: 'Acme', categories: [{ id: 'acme', name: 'Acme', color: '#4CC3E6' }],
    modules: [{ name: 'acme.internal.backup_agent', category: 'acme', palette: ['schedule'], args: { schedule: { kind: 'choice', choices: ['nightly', 'hourly'], required: true } } }]
  })});`;
  SX.addUserModuleSet(text);
  assert.equal(SX.module('acme.internal.backup_agent').category, 'acme');
  assert.ok(JSON.parse(SX.readStorage('scransible.moduleSets')).some(s => s.collection === 'acme.internal'));
  assert.throws(() => SX.addUserModuleSet('{"collection": "nope"}'), /namespace\.name/);
  SX.removeUserModuleSet('acme.internal');
  assert.equal(SX.module('acme.internal.backup_agent'), null);
});

test('the example project matches the reference playbook and passes lint but one warning', async () => {
  const { SX } = await openApp();
  const project = SX.exampleProject();
  const yaml = SX.Ansible.playbookYaml(SX.activePlaybook(project), project.settings);
  assert.equal(yaml.problem, null);
  assert.match(yaml.text, /- name: Configure web tier\n  hosts: webservers\n  become: true\n  gather_facts: true\n  vars:\n    app_env: production/);
  assert.match(yaml.text, /community\.general\.ufw:\n        rule: allow\n        to_port: "\{\{ http_port \}\}"/);
  assert.match(yaml.text, /notify: reload nginx\n      tags:\n        - nginx\n        - config/);
  const lint = SX.Lint.run(project);
  assert.deepEqual(plain(lint.issues.map(i => i.rule)), ['no-changed-when']);
  // Parsing the YAML back gives the same YAML.
  const parsed = SX.Ansible.parsePlaybook(yaml.text);
  assert.equal(SX.Ansible.playbookYaml({ items: parsed.items }, project.settings).text, yaml.text);
});

const TRICKY = ['{{ inventory_hostname }}', 'Result: done', 'see #42', '0755', 'y', 'n', '~', 'null', '1:20', '1_000', '0x1F', '.inf',
  '2001-12-14', '!reload', '*alias', '&anchor', '@x', '`x', '- item', '? x', "'quoted'", '"dq"', '%x', ' leading', 'trailing ', '=', '<<',
  '|', '>', '[1,2]', '{a: 1}', 'line1\nline2', 'ünïcode ✓', '<b>not html</b>'];

function trickyProject(SX) {
  const project = SX.newProject('tricky');
  const play = SX.newPlay({ name: 'Tricky', hosts: 'all', vars: TRICKY.map((v, i) => SX.newVar(`v${i}`, v)) });
  play.tasks.push(SX.newTask('ansible.builtin.debug', { name: 'Echo', args: { msg: '{{ v0 }}' }, kw: Object.fromEntries(TRICKY.map((v, i) => [`k${i}`, v])) }));
  SX.activePlaybook(project).items.push(play);
  return SX.normalizeProject(project);
}

test('strings YAML would misread come back unchanged', async () => {
  const { SX, window } = await openApp();
  const project = trickyProject(SX);
  const object = SX.Ansible.playbookObject(SX.activePlaybook(project), project.settings);
  const yaml = SX.Ansible.playbookYaml(SX.activePlaybook(project), project.settings);
  assert.equal(yaml.problem, null);
  assert.deepEqual(plain(window.jsyaml.load(yaml.text)), plain(object));
  TRICKY.forEach((value, i) => assert.equal(object[0].vars[`v${i}`], value));
});

test('PyYAML (what Ansible uses) reads the output the same way', { skip: !hasPyYaml && 'python3 with PyYAML not found' }, async () => {
  const { SX } = await openApp();
  const project = trickyProject(SX);
  const yaml = SX.Ansible.playbookYaml(SX.activePlaybook(project), project.settings);
  const result = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin)))'], { input: yaml.text, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), plain(SX.Ansible.playbookObject(SX.activePlaybook(project), project.settings)));
});

test('typed values: booleans and integers where safe, strings everywhere else', async () => {
  const { SX } = await openApp();
  const play = SX.newPlay({ name: 'P', hosts: 'all', vars: [SX.newVar('vlan', '10'), SX.newVar('mode', '0644'), SX.newVar('version', '15.10'), SX.newVar('flag', 'yes')] });
  play.tasks.push(SX.newTask('ansible.builtin.shell', { name: 'T', args: { cmd: 'true' }, kw: { retries: '3', ignore_errors: 'yes', become: true, notify: ['h'], tags: ['one'] } }));
  const [out] = plain(SX.Ansible.playbookObject({ items: [play] }, {}));
  assert.deepEqual(out.vars, { vlan: 10, mode: '0644', version: '15.10', flag: true });
  assert.deepEqual(out.tasks[0], { name: 'T', 'ansible.builtin.shell': { cmd: 'true' }, retries: 3, ignore_errors: true, become: true, notify: 'h', tags: 'one' });
  const short = plain(SX.Ansible.playbookObject({ items: [play] }, { fqcn: false }));
  assert.ok('shell' in short[0].tasks[0], 'FQCN off writes builtin short names');
});

test('real Ansible runs a playbook built from blocks', { skip: !hasAnsible && 'ansible-playbook not found' }, async () => {
  const { SX } = await openApp();
  const t = (module, name, args, kw) => SX.newTask(module, { name, args, kw });
  const play = SX.newPlay({
    name: 'Local', hosts: 'localhost', kw: { connection: 'local', gather_facts: false },
    vars: [SX.newVar('ansible_python_interpreter', '{{ ansible_playbook_python }}'), SX.newVar('vlan_id', '10'), SX.newVar('greeting', 'Result: done #42')],
    tasks: [
      t('ansible.builtin.shell', 'Shell', { cmd: 'echo "hello: world" | tr a-z A-Z' }, { register: 'out', changed_when: 'true', notify: ['say done'] }),
      t('ansible.builtin.assert', 'Check', { that: ['vlan_id is integer and vlan_id == 10', 'greeting == "Result: done #42"', 'out.stdout == "HELLO: WORLD"'] }),
      t('ansible.builtin.meta', 'Flush', { _raw: 'flush_handlers' }),
      SX.newBlock({
        name: 'Try', block: [t('ansible.builtin.fail', 'Fail on purpose', { msg: 'boom: expected' })],
        rescue: [t('ansible.builtin.debug', 'Rescued', { msg: 'rescued after {{ ansible_failed_result.msg }}' })]
      })
    ],
    handlers: [t('ansible.builtin.debug', 'say done', { msg: 'handler ran' })]
  });
  const yaml = SX.Ansible.playbookYaml({ items: [play] }, { fqcn: true });
  const file = join(mkdtempSync(join(tmpdir(), 'scransible-')), 'playbook.yml');
  writeFileSync(file, yaml.text);
  const result = spawnSync('ansible-playbook', ['-i', 'localhost,', file], {
    encoding: 'utf8', env: { ...process.env, ANSIBLE_NOCOLOR: '1', ANSIBLE_LOCALHOST_WARNING: 'False', ANSIBLE_INVENTORY_UNPARSED_WARNING: 'False' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RUNNING HANDLER \[say done\]/);
  assert.match(result.stdout, /rescued after boom: expected/);
  assert.match(result.stdout, /failed=0 .*rescued=1/);
});

test('import maps YAML to blocks with exact line ranges', async () => {
  const { SX } = await openApp();
  const text = `- name: Web
  hosts: web
  roles:
    - common
    - role: nginx
      vars: { workers: 4 }
  tasks:
    - name: Short names and key=value
      apt: name=git state=present

    - meta: flush_handlers
    - name: With args
      command: ./run.sh
      args:
        chdir: /srv
      notify: restart app
      tags: a, b
    - name: Unknown
      acme.internal.backup_agent:
        schedule: nightly
    - local_action:
        module: debug
        msg: hi
  handlers:
    - name: restart app
      service: { name: app, state: restarted }
`;
  const parsed = SX.Ansible.parsePlaybook(text);
  const [play] = parsed.items;
  assert.equal(play.hosts, 'web');
  assert.deepEqual(plain(play.roles.map(r => [r.role, r.vars])), [['common', {}], ['nginx', { workers: 4 }]]);
  const [apt, meta, cmd, unknown, local] = play.tasks;
  assert.equal(apt.module, 'ansible.builtin.apt');
  assert.deepEqual(plain(apt.args), { name: 'git', state: 'present' });
  assert.deepEqual(plain(meta.args), { _raw: 'flush_handlers' });
  assert.deepEqual(plain(cmd.args), { _raw: './run.sh', chdir: '/srv' });
  assert.deepEqual(plain(cmd.kw), { notify: ['restart app'], tags: ['a', 'b'] });
  assert.equal(unknown.module, 'acme.internal.backup_agent');
  assert.deepEqual(plain([...parsed.unknownModules]), ['acme.internal.backup_agent']);
  assert.equal(local.module, 'ansible.builtin.debug');
  assert.equal(local.kw.delegate_to, 'localhost');
  assert.deepEqual(plain(parsed.ranges.get(apt.id)), { start: 8, end: 9 });
  assert.deepEqual(plain(parsed.ranges.get(cmd.id)), { start: 12, end: 17 });
  assert.deepEqual(plain(parsed.ranges.get(play.handlers[0].id)), { start: 25, end: 26 });
  // Free-form and args: come back out the way Ansible expects them.
  const out = plain(SX.Ansible.taskObject(cmd, {}));
  assert.deepEqual(out['ansible.builtin.command'], './run.sh');
  assert.deepEqual(out.args, { chdir: '/srv' });
});

test('project export: archives round-trip and contain what Ansible needs', async () => {
  const { SX } = await openApp();
  const project = SX.exampleProject();
  const files = SX.Ansible.projectFiles(project);
  const paths = files.map(f => f.path);
  for (const expected of ['site.yml', 'ansible.cfg', 'requirements.yml', 'inventory/production.ini', 'inventory/group_vars/webservers.yml',
    'roles/nginx/tasks/main.yml', 'roles/nginx/handlers/main.yml', 'roles/nginx/defaults/main.yml', 'roles/nginx/meta/main.yml', 'roles/nginx/templates/nginx.conf.j2', '.scransible/layout.json']) {
    assert.ok(paths.includes(expected), `${expected} is exported`);
  }
  assert.match(files.find(f => f.path === 'requirements.yml').content, /community\.general/);
  assert.match(files.find(f => f.path === 'roles/nginx/meta/main.yml').content, /- role: common/);
  const zip = await SX.Archive.unzip(await SX.Archive.zip(files).arrayBuffer());
  assert.deepEqual(zip.map(f => [f.path, SX.Archive.text(f.bytes)]), files.map(f => [f.path, f.content]));
  const tar = await SX.Archive.untarGz(await (await SX.Archive.tarGz(files)).arrayBuffer());
  assert.deepEqual(tar.map(f => [f.path, SX.Archive.text(f.bytes)]), files.map(f => [f.path, f.content]));
});

test('INI inventories round-trip', async () => {
  const { SX } = await openApp();
  const inv = SX.exampleProject().inventories[0];
  const again = SX.Ansible.parseIniInventory(SX.Ansible.inventoryIni(inv), inv.path);
  const shape = i => i.groups.filter(g => g.name !== 'all').map(g => [g.name, [...g.hosts].sort(), [...g.children].sort()]).sort();
  assert.deepEqual(plain(shape(again)), plain(shape(inv)));
  assert.deepEqual(plain(again.hosts.map(h => [h.name, h.address])), plain(inv.hosts.map(h => [h.name, h.address])));
});

test('lint flags what matters and fixes apply', async () => {
  const { SX } = await openApp();
  const play = SX.newPlay({ name: 'P', hosts: '' });
  const file = SX.newTask('ansible.builtin.file', { name: 'F', args: { colour: 'blue', mode: '{{ undefined_mode }}' }, kw: { notify: ['nobody'] } });
  const cmd = SX.newTask('ansible.builtin.command', { name: 'C', args: { cmd: 'ls' } });
  play.tasks.push(file, cmd);
  const project = SX.newProject('lint');
  SX.activePlaybook(project).items.push(play);
  SX.normalizeProject(project);
  const rules = plain(SX.Lint.run(project).issues.map(i => i.rule)).sort();
  assert.deepEqual(rules, ['missing-required', 'no-changed-when', 'no-hosts', 'notify-handler', 'undefined-var', 'unknown-arg']);
  const fix = SX.Lint.run(project).issues.find(i => i.rule === 'no-changed-when').fix;
  fix.apply(cmd);
  assert.equal(cmd.kw.changed_when, 'false');
});

test('saves from the single-file builder are carried over', async () => {
  const legacy = [{
    id: 'a', type: 'play', params: { name: 'Old', hosts: 'all', gather_facts: 'no', connection: 'local', vars: [] }, vars: [{ k: 'x', v: '1' }],
    custom: [{ k: 'serial', v: '2' }], when: '', tags: '', become: '',
    children: [
      { id: 'b', type: 'task', params: { name: 'Lines', module: 'cisco.ios.ios_config' }, moduleArgs: { lines: ['a', 'b'] }, custom: [{ k: 'notify', v: 'h' }], when: 'x', tags: 't1,t2', become: 'yes', children: [], rescue: [], always: [] },
      { id: 'c', type: 'block', params: { name: 'B' }, moduleArgs: {}, custom: [], vars: [], when: '', tags: '', become: '', children: [{ id: 'd', type: 'play', params: { name: 'Stray', hosts: 'all' }, children: [] }], rescue: [], always: [] }
    ],
    handlers: []
  }];
  const { SX } = await openApp({ legacy });
  const items = SX.activePlaybook(SX.store.project).items;
  assert.deepEqual(plain(items.map(i => i.name)), ['Old', 'Stray'], 'a play nested in a block moves to the top level');
  const [play] = items;
  assert.deepEqual(plain(play.kw), { connection: 'local', gather_facts: false, serial: 2 });
  assert.deepEqual(plain(play.tasks[0].kw), { when: 'x', tags: ['t1', 't2'], become: true, notify: ['h'] });
  assert.deepEqual(plain(play.tasks[0].args), { lines: ['a', 'b'] });
});

test('every change is one undo step; typing in one field is one step', async () => {
  const { SX } = await openApp();
  const store = SX.store;
  store.replace(SX.exampleProject());
  const task = () => SX.activePlaybook(store.project).items[0].tasks[0];
  for (const name of ['I', 'In', 'Ins']) store.typing('name-field', p => { SX.activePlaybook(p).items[0].tasks[0].name = name; }, 'test');
  assert.equal(task().name, 'Ins');
  store.commit(p => { SX.activePlaybook(p).items[0].tasks.pop(); });
  store.undo();
  assert.equal(SX.activePlaybook(store.project).items[0].tasks.length, 5);
  store.undo();
  assert.equal(task().name, 'Install packages');
  store.redo();
  assert.equal(task().name, 'Ins');
  assert.equal(JSON.parse(SX.readStorage('scransible.project')).playbooks[0].items[0].tasks[0].name, 'Ins', 'changes are saved');
});

test('drag and drop: palette blocks, moves, trash, keyword pills and variable reporters', async () => {
  const { SX } = await openApp();
  SX.store.replace(SX.exampleProject());
  await tick();
  const play = () => SX.activePlaybook(SX.store.project).items[0];
  const handler = SX.DnD.handler;
  handler.drop({ kind: 'new', type: 'task', module: 'ansible.builtin.copy' }, { kind: 'stack', owner: play().id, section: 'tasks', index: 1 });
  assert.equal(play().tasks[1].module, 'ansible.builtin.copy');
  const block = play().tasks.find(t => t.type === 'block');
  handler.drop({ kind: 'move', type: 'task', id: play().tasks[0].id }, { kind: 'stack', owner: block.id, section: 'always', index: 0 });
  assert.equal(SX.findNode(SX.store.project, block.id).always[0].name, 'Install packages');
  handler.drop({ kind: 'move', type: 'task', id: play().tasks[0].id }, { kind: 'trash' });
  assert.ok(!play().tasks.some(t => t.module === 'ansible.builtin.copy'));
  const svc = play().tasks.find(t => t.name === 'Ensure nginx running');
  handler.drop({ kind: 'new', type: 'pill', keyword: 'when' }, { kind: 'node', id: svc.id });
  assert.equal(SX.findNode(SX.store.project, svc.id).kw.when, '');
  handler.drop({ kind: 'new', type: 'reporter', name: 'server_name' }, { kind: 'slot', key: `${svc.id}|name` });
  assert.equal(SX.findNode(SX.store.project, svc.id).args.name, '{{ server_name }}');
  handler.drop({ kind: 'new', type: 'play' }, { kind: 'canvas', x: 600, y: 40 });
  assert.equal(SX.activePlaybook(SX.store.project).items.length, 2);
  assert.deepEqual(plain(SX.activePlaybook(SX.store.project).items[1].pos), { x: 600, y: 40 });
});

test('every page renders, and text is never parsed as HTML', async () => {
  const payload = '<img src=x onerror="window.pwned = true">';
  const { SX, window, doc } = await openApp();
  const project = SX.exampleProject();
  const play = SX.activePlaybook(project).items[0];
  play.name = payload;
  play.tasks[0].name = payload;
  play.tasks[0].args.name = [payload];
  play.vars.push(SX.newVar(payload, payload));
  project.roles[0].name = 'common';
  project.roles[0].description = payload;
  SX.store.replace(SX.normalizeProject(project));
  for (const route of ['#/builder', '#/roles/common', '#/inventory', '#/import', '#/export']) {
    window.location.hash = route;
    await tick();
    await tick();
    assert.ok(doc.querySelector('.topbar .nav'), `${route} renders the top bar`);
    assert.equal(doc.querySelectorAll('img').length, 0, `${route} creates no img element`);
  }
  assert.equal(window.pwned, undefined);
  window.location.hash = '#/builder';
  await tick();
  assert.ok([...doc.querySelectorAll('.stage .blk-title')].some(t => t.textContent === payload), 'the payload shows as text');
});

test('read-only sessions show blocks without editing controls', async () => {
  const { SX, window, doc } = await openApp();
  SX.session = { readOnly: true, project: SX.exampleProject(), title: 'example', makeEditable() {}, close() {} };
  window.location.hash = '#/import';
  await tick();
  window.location.hash = '#/builder';
  await tick();
  assert.ok(doc.querySelector('.readonly-banner'));
  assert.ok(doc.querySelector('.stage .stack-blk'));
  assert.equal(doc.querySelectorAll('.stage input, .stage select').length, 0);
});

test('the page loads the js-yaml version the tests use, before the app', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const [, version] = html.match(/ajax\/libs\/js-yaml\/([\d.]+)\/js-yaml\.min\.js/);
  assert.equal(version, pkg.devDependencies['js-yaml']);
  assert.ok(html.indexOf('js-yaml.min.js') < html.indexOf('src/core.js'));
  assert.ok(html.indexOf('modules/index.js') < html.indexOf('src/app.js'));
});

test('the module set builder turns ansible-doc output into a module set', { skip: !hasAnsibleDoc && 'ansible-doc not found' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'scransible-spec-'));
  const spec = join(dir, 'spec.json');
  writeFileSync(spec, JSON.stringify({ collection: 'ansible.builtin', title: 'Test', modules: { debug: { category: 'utilities', palette: ['msg'] }, meta: { category: 'control', palette: ['_raw'] } } }));
  const result = spawnSync('python3', [join(root, 'tools/build-module-set.py'), spec], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const set = JSON.parse(result.stdout.slice(result.stdout.indexOf('(') + 1, result.stdout.lastIndexOf(')')));
  assert.equal(set.modules[0].name, 'ansible.builtin.debug');
  assert.equal(set.modules[0].args.verbosity.kind, 'int');
  assert.ok(set.modules[1].args._raw.choices.includes('flush_handlers'));
  writeFileSync(spec, JSON.stringify({ collection: 'ansible.builtin', modules: { debug: { category: 'utilities', palette: ['nope'] } } }));
  assert.notEqual(spawnSync('python3', [join(root, 'tools/build-module-set.py'), spec], { encoding: 'utf8' }).status, 0, 'undocumented palette arguments are rejected');
});

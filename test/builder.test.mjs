import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import jsyaml from 'js-yaml';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Strips cross-realm prototypes so page objects compare cleanly with deepEqual.
const plain = value => JSON.parse(JSON.stringify(value));

const hasCommand = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const hasPyYaml = hasCommand('python3', ['-c', 'import yaml']);
const hasAnsible = hasCommand('ansible-playbook', ['--version']);

// Loads index.html in jsdom. jsdom doesn't fetch the CDN copy of js-yaml, so the
// same version is injected from node_modules.
function openPage({ saved, yaml = true } = {}) {
  const { window } = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    beforeParse(win) {
      if (yaml) win.jsyaml = jsyaml;
      win.structuredClone = structuredClone;
      win.confirm = () => true;
      if (saved !== undefined) {
        win.localStorage.setItem('ansiblePlaybookBuilderState', typeof saved === 'string' ? saved : JSON.stringify(saved));
      }
    }
  });
  const run = code => window.eval(code);
  run(`window.testApi = {
    add(parentId, data, section = 'children') {
      insertItem(data, parentId, section, Infinity);
      const list = containerOf(parentId, section);
      return list[list.length - 1];
    }
  };`);
  return {
    window,
    run,
    add: (parentId, data, section) => window.testApi.add(parentId, data, section),
    state: () => run('state'),
    yaml: () => window.document.getElementById('yaml-out').textContent,
    warnings: () => [...window.document.querySelectorAll('#warnings li')].map(li => li.textContent),
    status: () => window.document.getElementById('warnings').textContent
  };
}

// Strings that must stay strings. (yes/no/on/off/true/false and integers are turned
// into real booleans and numbers on purpose; see the next tests.)
const TRICKY = ['{{ inventory_hostname }}', 'Result: done', 'see #42', '0755', 'y', 'n', 'Yes please', '~', 'null', '1:20',
  '1_000', '0x1F', '.inf', '2001-12-14', '!reload', '*alias', '&anchor', '@x', '`x', '- item', '? x', "'quoted'", '"dq"',
  '%x', ' leading', 'trailing ', '=', '<<', '|', '>', '[1,2]', '{a: 1}', 'line1\nline2', 'ünïcode ✓', '<b>not html</b>'];

function buildTrickyPlaybook(p) {
  const play = p.add('root', { type: 'play', preset: 'plain' });
  const task = p.add(play.id, { type: 'task', module: 'ansible.builtin.debug' });
  TRICKY.forEach((value, i) => {
    play.vars.push({ k: `v${i}`, v: value });
    task.custom.push({ k: `k${i}`, v: value });
  });
  p.run('render()');
  return play;
}

test('generates the expected YAML for a network playbook', () => {
  const p = openPage();
  const play = p.add('root', { type: 'play', preset: 'ios' });
  p.add(play.id, { type: 'task', module: 'cisco.ios.ios_config' });
  const block = p.add(play.id, { type: 'block' });
  p.add(block.id, { type: 'task', module: 'cisco.ios.ios_command' });
  p.add(block.id, { type: 'task', module: 'ansible.builtin.fail' }, 'rescue');
  p.add(play.id, { type: 'task', module: 'ansible.builtin.debug' }, 'handlers');
  assert.equal(p.yaml(), `---
- name: Configure Network
  hosts: all
  connection: ansible.netcommon.network_cli
  gather_facts: false
  vars:
    ansible_network_os: cisco.ios.ios
  tasks:
    - name: Execute Task
      cisco.ios.ios_config:
        lines:
          - description Configured by Ansible
        parents:
          - interface GigabitEthernet1/0/1
    - name: Main Logic Block
      block:
        - name: Execute Task
          cisco.ios.ios_command:
            commands:
              - show version
      rescue:
        - name: Execute Task
          ansible.builtin.fail:
            msg: Task failed
  handlers:
    - name: Execute Task
      ansible.builtin.debug:
        msg: Debugging task
`);
  assert.equal(p.run('yamlProblem'), null);
});

test('values that YAML would misread come back unchanged', () => {
  const p = openPage();
  buildTrickyPlaybook(p);
  const intended = plain(p.run('buildPlaybookObject()'));
  assert.deepEqual(plain(jsyaml.load(p.yaml())), intended);
  assert.equal(p.run('yamlProblem'), null);
  TRICKY.forEach((value, i) => assert.equal(intended[0].vars[`v${i}`], value, `var v${i}`));
});

test('YAML 1.1 (PyYAML, which Ansible uses) reads the output the same way', { skip: !hasPyYaml && 'python3 with PyYAML not found' }, () => {
  const p = openPage();
  buildTrickyPlaybook(p);
  const result = spawnSync('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin)))'], { input: p.yaml(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), plain(p.run('buildPlaybookObject()')));
});

test('plain-text fields become booleans and integers only where that is safe', () => {
  const p = openPage();
  const play = p.add('root', { type: 'play', preset: 'plain' });
  const task = p.add(play.id, { type: 'task', module: 'ansible.builtin.shell' });
  task.moduleArgs.cmd = 'true';
  task.custom.push({ k: 'retries', v: '3' }, { k: 'ignore_errors', v: 'yes' }, { k: 'run_once', v: 'On' }, { k: 'blank', v: '' });
  task.become = 'yes';
  play.vars.push({ k: 'vlan', v: '10' }, { k: 'mode', v: '0644' }, { k: 'version', v: '15.10' }, { k: 'big', v: '123456789012345678901' });
  p.run('render()');
  const [out] = plain(p.run('buildPlaybookObject()'));
  assert.equal(out.gather_facts, false);
  assert.deepEqual(out.vars, { vlan: 10, mode: '0644', version: '15.10', big: '123456789012345678901' });
  assert.deepEqual(out.tasks[0], {
    name: 'Execute Task',
    'ansible.builtin.shell': { cmd: 'true' },  // a str argument: runs the `true` command
    become: true,
    retries: 3,
    ignore_errors: true,
    run_once: true,
    blank: null
  });
});

test('real Ansible runs a generated playbook', { skip: !hasAnsible && 'ansible-playbook not found' }, () => {
  const p = openPage();
  const play = p.add('root', { type: 'play', preset: 'plain' });
  play.params.hosts = 'localhost';
  play.params.connection = 'local';
  play.vars.push(
    { k: 'ansible_python_interpreter', v: '{{ ansible_playbook_python }}' },
    { k: 'vlan_id', v: '10' }, { k: 'file_mode', v: '0644' }, { k: 'greeting', v: 'Result: done #42' }
  );
  const shell = p.add(play.id, { type: 'task', module: 'ansible.builtin.shell' });
  shell.moduleArgs.cmd = 'echo "hello: world" | tr a-z A-Z';
  shell.custom.push({ k: 'register', v: 'out' }, { k: 'changed_when', v: 'true' }, { k: 'notify', v: 'say done' });
  const check = p.add(play.id, { type: 'task', module: 'ansible.builtin.assert' });
  check.moduleArgs.that = ['vlan_id is integer and vlan_id == 10', 'file_mode == "0644"', 'greeting == "Result: done #42"', 'out.stdout == "HELLO: WORLD"'];
  const block = p.add(play.id, { type: 'block' });
  p.add(block.id, { type: 'task', module: 'ansible.builtin.fail' }).moduleArgs.msg = 'boom: expected';
  p.add(block.id, { type: 'task', module: 'ansible.builtin.debug' }, 'rescue').moduleArgs.msg = 'rescued after {{ ansible_failed_result.msg }}';
  p.add(play.id, { type: 'task', module: 'ansible.builtin.debug' }, 'handlers').params.name = 'say done';
  p.run('render()');
  assert.deepEqual(p.warnings(), []);

  const file = join(mkdtempSync(join(tmpdir(), 'scransible-')), 'playbook.yml');
  writeFileSync(file, p.yaml());
  const result = spawnSync('ansible-playbook', ['-i', 'localhost,', file], {
    encoding: 'utf8',
    env: { ...process.env, ANSIBLE_NOCOLOR: '1', ANSIBLE_LOCALHOST_WARNING: 'False', ANSIBLE_INVENTORY_UNPARSED_WARNING: 'False' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /rescued after boom: expected/);
  assert.match(result.stdout, /RUNNING HANDLER \[say done\]/);
  assert.match(result.stdout, /failed=0 .*rescued=1/);
});

test('drop rules: plays only at the top level, handlers take tasks only', () => {
  const p = openPage();
  const can = (parent, section, type) => p.run(`canDropOn(${JSON.stringify(parent)}, ${JSON.stringify(section)}, { type: ${JSON.stringify(type)} })`);
  assert.equal(can('root', 'children', 'play'), true);
  assert.equal(can('root', 'children', 'task'), false);
  assert.equal(can('play', 'children', 'play'), false);
  assert.equal(can('block', 'children', 'play'), false);
  assert.equal(can('play', 'children', 'task'), true);
  assert.equal(can('play', 'children', 'block'), true);
  assert.equal(can('play', 'handlers', 'task'), true);
  assert.equal(can('play', 'handlers', 'block'), false);
  assert.equal(can('play', 'rescue', 'task'), false);
  assert.equal(can('block', 'rescue', 'block'), true);
  assert.equal(can('block', 'always', 'task'), true);
  assert.equal(can('task', 'children', 'task'), false);

  const play = p.add('root', { type: 'play', preset: 'plain' });
  const outer = p.add(play.id, { type: 'block' });
  const inner = p.add(outer.id, { type: 'block' });
  assert.equal(p.run(`accepts(${JSON.stringify(inner.id)}, 'children', { type: 'block', moveId: ${JSON.stringify(outer.id)} })`), false);
  assert.equal(p.run(`accepts(${JSON.stringify(outer.id)}, 'children', { type: 'block', moveId: ${JSON.stringify(outer.id)} })`), false);
  assert.equal(p.run(`accepts(${JSON.stringify(play.id)}, 'children', { type: 'block', moveId: ${JSON.stringify(inner.id)} })`), true);
});

test('move, reorder, duplicate, delete, undo and redo', () => {
  const p = openPage();
  const names = list => Array.from(list, item => item.params.name);
  const play = p.add('root', { type: 'play', preset: 'plain' });
  ['a', 'b', 'c'].forEach(name => { p.add(play.id, { type: 'task', module: 'ansible.builtin.debug' }).params.name = name; });
  const block = p.add(play.id, { type: 'block' });
  const tasks = () => p.state()[0].children;

  p.run(`moveBy(${JSON.stringify(tasks()[2].id)}, -1)`);
  assert.deepEqual(names(tasks()), ['a', 'c', 'b', 'Main Logic Block']);

  p.run(`insertItem({ type: 'task', moveId: ${JSON.stringify(tasks()[0].id)} }, ${JSON.stringify(block.id)}, 'rescue', 0)`);
  assert.deepEqual(names(tasks()), ['c', 'b', 'Main Logic Block']);
  assert.deepEqual(names(tasks()[2].rescue), ['a']);

  p.run(`duplicateItem(${JSON.stringify(tasks()[2].id)})`);
  assert.deepEqual(names(tasks()), ['c', 'b', 'Main Logic Block', 'Main Logic Block']);
  const ids = [];
  p.run('walkItems')(p.state(), item => ids.push(item.id));
  assert.equal(new Set(ids).size, ids.length, 'duplicated items get new ids');

  p.run(`deleteItem(${JSON.stringify(tasks()[0].id)})`);
  assert.deepEqual(names(tasks()), ['b', 'Main Logic Block', 'Main Logic Block']);

  p.run('undo()');
  assert.deepEqual(names(tasks()), ['c', 'b', 'Main Logic Block', 'Main Logic Block']);
  p.run('undo(); undo()');
  assert.deepEqual(names(tasks()), ['a', 'c', 'b', 'Main Logic Block']);
  p.run('redo()');
  assert.deepEqual(names(tasks()), ['c', 'b', 'Main Logic Block']);
  assert.equal(p.window.document.getElementById('redo-btn').disabled, false);
});

test('typing in a field is one undo step and is autosaved', () => {
  const p = openPage();
  p.add('root', { type: 'play', preset: 'plain' });
  const input = p.window.document.querySelector('.cblock.play [data-key$=":name"]');
  for (const text of ['N', 'Ne', 'New']) {
    input.value = text;
    input.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  }
  assert.equal(JSON.parse(p.window.localStorage.getItem('ansiblePlaybookBuilderState'))[0].params.name, 'New');
  assert.equal(p.window.document.querySelector('.cblock.play .btitle').textContent, 'PLAY New');
  p.run('undo()');
  assert.equal(p.state()[0].params.name, 'Configure Network');
});

test('switching modules keeps edited arguments the new module accepts', () => {
  const p = openPage();
  const play = p.add('root', { type: 'play', preset: 'plain' });
  const task = p.add(play.id, { type: 'task', module: 'cisco.ios.ios_config' });
  task.moduleArgs.lines = ['shutdown'];
  task.moduleArgs.save_when = 'modified';
  p.run(`changeTaskModule(${JSON.stringify(task.id)}, 'cisco.nxos.nxos_config')`);
  assert.deepEqual(plain(p.state()[0].children[0].moduleArgs), { lines: ['shutdown'], parents: ['interface Ethernet1/1'], save_when: 'modified' });

  p.run(`changeTaskModule(${JSON.stringify(task.id)}, 'ansible.builtin.debug')`);
  assert.deepEqual(plain(p.state()[0].children[0].moduleArgs), { msg: 'Debugging task' });
  assert.match(p.status(), /has no lines, save_when option/);
  p.run('undo()');
  assert.equal(p.state()[0].children[0].params.module, 'cisco.nxos.nxos_config');
});

test('loads state saved by the previous version', () => {
  const p = openPage({
    saved: [{
      id: 'id_old', type: 'play',
      params: { name: 'Old play', hosts: 'all', gather_facts: 'no', vars: [] },
      custom: [], vars: [], when: '', tags: '', become: '',
      children: [
        { id: 'id_t', type: 'task', params: { name: 'Old config', module: 'cisco.ios.ios_config' },
          moduleArgs: { lines: 'interface GigabitEthernet1/0/1\ndescription Configured by Ansible' },
          custom: [], vars: [], when: '', tags: '', become: '', children: [], rescue: [], always: [] },
        { id: 'id_b', type: 'block', params: { name: 'Old block' }, moduleArgs: {}, custom: [], vars: [], when: '', tags: '', become: '',
          children: [{ id: 'id_p', type: 'play', params: { name: 'Stray play', hosts: 'all', gather_facts: 'no', vars: [] },
            moduleArgs: {}, custom: [], vars: [], when: '', tags: '', become: '', children: [], rescue: [], always: [] }],
          rescue: [], always: [] }
      ],
      rescue: [], always: []
    }]
  });
  const [play] = p.state();
  assert.equal('vars' in play.params, false, 'the unused play "vars" field is dropped');
  assert.deepEqual(plain(play.children[0].moduleArgs.lines), ['interface GigabitEthernet1/0/1', 'description Configured by Ansible']);
  assert.deepEqual(plain(play.handlers), []);
  assert.doesNotMatch(p.yaml(), /Stray play|Unsupported/);
  assert.ok(p.warnings().some(w => w.includes('Play "Stray play" is inside Block "Old block"')));
});

test('malformed imports are rejected and leave the current state alone', () => {
  const p = openPage();
  p.add('root', { type: 'play', preset: 'plain' });
  const before = JSON.stringify(p.state());
  const bad = {
    '{}': 'expected a list of plays',
    '{nope': /JSON/,
    '[{"type":"task"}]': 'top-level item 1 is not a play',
    '[{"type":"play","children":"x"}]': 'play 1 has an invalid "children"',
    '[{"type":"play","handlers":[{"type":"script"}]}]': 'play 1 > handlers 1 has an unknown type',
    '[{"type":"play","custom":[null]}]': 'play 1 has an invalid parameter or var'
  };
  for (const [json, message] of Object.entries(bad)) {
    assert.throws(() => p.run(`parseState(${JSON.stringify(json)})`), typeof message === 'string' ? { message } : message, json);
  }
  assert.equal(JSON.stringify(p.state()), before);
});

test('imported text is shown as text, never run as HTML', () => {
  const payload = '<img src=x onerror="window.pwned = true">';
  const p = openPage({
    saved: [{ id: "x'); window.pwned = true; ('", type: 'play', params: { name: payload, hosts: payload },
      custom: [{ k: payload, v: payload }], vars: [{ k: payload, v: payload }],
      children: [{ type: 'task', params: { name: payload, module: payload }, moduleArgs: { [payload]: payload } }] }]
  });
  const doc = p.window.document;
  assert.equal(doc.querySelectorAll('img').length, 0);
  assert.equal(p.window.pwned, undefined);
  assert.ok([...doc.querySelectorAll('.f-label')].some(label => label.textContent === payload));
  assert.ok(doc.querySelector('.cblock.play .btitle').textContent.includes(payload));
});

test('warns about missing required arguments, unknown arguments and missing handlers', () => {
  const p = openPage();
  const play = p.add('root', { type: 'play', preset: 'plain' });
  const file = p.add(play.id, { type: 'task', module: 'ansible.builtin.file' });
  delete file.moduleArgs.path;
  file.moduleArgs.colour = 'blue';
  file.custom.push({ k: 'notify', v: 'restart nothing' });
  const aliased = p.add(play.id, { type: 'task', module: 'ansible.builtin.file' });
  delete aliased.moduleArgs.path;
  aliased.moduleArgs.dest = '/tmp/x';  // an alias of path
  p.run('render()');
  assert.deepEqual(p.warnings(), [
    'Task "Execute Task" is missing "path", which ansible.builtin.file requires.',
    'Task "Execute Task": "colour" is not an option of ansible.builtin.file.',
    'Task "Execute Task" notifies "restart nothing", but no handler in this play has that name.'
  ]);
});

test('without js-yaml the page says so instead of producing YAML', () => {
  const p = openPage({ yaml: false });
  p.add('root', { type: 'play', preset: 'plain' });
  assert.equal(p.yaml(), '');
  assert.match(p.status(), /js-yaml library did not load/);
});

test('the page loads the same js-yaml version the tests use', () => {
  const [, version] = html.match(/ajax\/libs\/js-yaml\/([\d.]+)\/js-yaml\.min\.js/);
  assert.equal(version, pkg.devDependencies['js-yaml']);
});

test('module registry defaults only use documented arguments of the right kind', () => {
  const p = openPage();
  const modules = plain(p.run('MODULES'));
  for (const module of modules) {
    for (const [name, value] of Object.entries(module.defaults)) {
      const spec = p.run(`argSpec(moduleInfo(${JSON.stringify(module.name)}), ${JSON.stringify(name)})`);
      assert.ok(spec, `${module.name} default "${name}" is a documented argument`);
      if (spec.kind === 'list') assert.ok(Array.isArray(value), `${module.name} "${name}" default is a list`);
      if (spec.kind === 'choice') assert.ok(spec.choices.includes(value), `${module.name} "${name}" default is an allowed choice`);
    }
  }
});

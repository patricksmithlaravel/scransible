# Scransible

A block builder for Ansible, aimed at network automation as much as servers. Plays,
tasks and keywords snap together like Scratch blocks; every block is exactly one piece
of Ansible YAML, and nothing in a block is lost on export.

Open `index.html` in a browser — no build step, no server. It loads
[js-yaml](https://github.com/nodeca/js-yaml) from cdnjs and its fonts from Google
Fonts, so it needs a network connection; offline it says so instead of producing YAML.

## Pages

- **Builder** — the category rail and block palette on the left, the canvas in the
  middle, the inspector on the right. Drag blocks out of the palette (or double-click
  them), drag them between sections, drop them on the bin or back on the palette to
  delete. Switch between **Blocks**, **Split** and **YAML** views: the YAML is editable,
  and valid edits update the blocks. The builder edits any task file: a playbook, or a
  role's `tasks/` and `handlers/` (pick it from the file menu at the top).
- **Roles** — the project's roles: their tasks and handlers as blocks, defaults,
  templates, dependencies, and where each role is used.
- **Inventory** — groups and hosts as cards (drag hosts between groups; hold ⌥/Alt to
  keep them in both), group and host variables, and a walk through Ansible's variable
  precedence for a host.
- **Import** — files, folders, `.zip` / `.tar.gz` archives, pasted YAML or a public
  GitHub repository. Playbooks, roles, inventories and `group_vars` / `host_vars` are
  detected and mapped to blocks, with each source line linked to its block. Open the
  result read-only, or as an editable copy merged into your project (undoable).
- **Export** — a single playbook, a project `.zip` (playbooks, roles, inventory,
  `group_vars`, `ansible.cfg`, `requirements.yml`), or one role as `.tar.gz`. Choose
  fully-qualified or short module names, quoting and indentation; the checks run first,
  and blocks with missing required parameters stop the download until they are filled in.

Undo and redo work everywhere (⌘Z / ⇧⌘Z, or Ctrl). Your project is saved in the browser
as you go; the project menu also saves snapshots and downloads or opens project files.

## Block grammar

| Shape | Is | YAML |
|---|---|---|
| Hat | a play (or `import_playbook`); nothing snaps above it | `- name: … hosts: …` |
| Stack | a task: module and name on top, parameters below | `- name: … ansible.builtin.apt: …` |
| Mouth | a play section — vars, roles, pre_tasks, tasks, post_tasks, handlers | `tasks:` |
| E-block | `block` / `rescue` / `always` | `block:` |
| Pill | a task keyword: when, loop, notify, register, tags, … | `when: …` |
| Reporter | a variable; drop it into a slot to write `{{ name }}` | `"{{ http_port }}"` |

Each parameter gets the slot its type asks for — text, a choice, a toggle, a list, a
Jinja expression or a condition — read from the module's argument spec. Color says what
kind of work a block does, and the label always names it too.

Field values are typed like YAML would read them, but safely: `yes`/`no`/`true`/`false`
and whole numbers become booleans and integers; `0644`, `15.10` and `{{ var }}` stay
strings and are quoted where needed. Module arguments documented as strings are never
converted, so `cmd: true` runs the `true` command. After generating YAML the app parses
it back and warns if it doesn't match.

## Keywords

Every playbook keyword Ansible documents is available, on the items it applies to
(play, role, block, task, handler) — 62 in all, from `when` and `loop` to
`become_method`, `async`, `delegate_facts` and `module_defaults`. The inspector always
shows a task's notify, tags, when, become and register; `become` says what it inherits
("Inherit from play (yes)"), and while privilege escalation is on, `become_user` and
`become_method` (with the installed become plugins, such as `enable` for network
devices, as suggestions) are shown too. Everything else is in the grouped
*+ Add keyword…* menu. Keywords Ansible would reject — a typo, or `gather_facts` on a
task — are flagged.

The catalog in `src/keywords.js` is generated from `ansible-doc -t keyword`; the
builder-specific parts (slot kinds, groups, suggestions) are in `tools/keywords.json`:

```bash
python3 tools/build-keywords.py > src/keywords.js
```

## Module sets

Every block in the palette comes from a **module set**: one file per collection in
`modules/`, listed in `modules/index.js`.

```
modules/
  index.js                  the files to load, in order
  ansible.builtin.js
  ansible.posix.js
  community.general.js
  cisco.ios.js
  cisco.nxos.js
```

A module set file is JSON inside one call, so the app can also read it as data:

```js
Scransible.registerModuleSet({
  "collection": "cisco.ios",
  "title": "Cisco IOS",
  "categories": [{ "id": "network", "name": "Network", "color": "#4CC3E6" }],
  "modules": [{
    "name": "cisco.ios.ios_config", "short": "ios_config", "category": "network",
    "description": "Module to manage configuration sections",
    "palette": ["parents", "lines"],
    "defaults": {},
    "args": { "lines": { "kind": "list", "aliases": ["commands"] }, "match": { "kind": "choice", "choices": ["line", "strict", "exact", "none"], "default": "line" } }
  }]
});
```

`palette` lists the arguments shown on the block itself, and `defaults` holds the values a
new block starts with. Argument kinds are `str`, `int`, `bool`, `choice`, `list` and `yaml` (nested data), with
`required`, `aliases`, `default` and a short `doc` where the module documents them.
Categories are the ten built-in ones (plays, control, variables, roles, packages, files,
services, commands, access, utilities) plus any a set adds.

**Add a module set**

- In the app: *Collections → Add module set…* and choose a module set file (`.js` or
  `.json`). It is kept in that browser; *Manage module sets…* removes it.
- For everyone: put the file in `modules/` and add it to `modules/index.js`.

**Build one from `ansible-doc`**

Write a short spec naming the modules you want, their palette category and the
arguments to show on each block (see `tools/module-sets/`), install the collection, and
run:

```bash
ansible-galaxy collection install cisco.ios
python3 tools/build-module-set.py tools/module-sets/cisco.ios.json > modules/cisco.ios.js
```

Everything else — argument types, choices, required flags, aliases, descriptions — comes
from `ansible-doc -j`. The builder refuses palette arguments the module doesn't document.

## Development

```bash
npm install
npm test
```

The tests load `index.html` in jsdom with all its scripts and module sets, using the same
js-yaml version the page loads. If `python3` with PyYAML and `ansible-playbook` are on
your PATH they also check that PyYAML reads the output identically, that Ansible runs
a generated playbook, and that `ansible-playbook --syntax-check` accepts every keyword the
builder offers on every kind of item; with `ansible-doc` they also exercise the module set
builder.
Otherwise those tests are skipped. CI installs all three.

The code is plain scripts sharing one `Scransible` namespace (`src/`), so it runs straight
from disk: `core.js` (DOM helpers and registries), `model.js` (project model, storage,
undo), `ansible.js` (YAML out and in, inventories, export files), `lint.js`, `archive.js`
(zip and tar.gz), `ui.js`, `blocks.js` (block rendering), `dnd.js` (drag and drop),
`pages/*.js` and `app.js` (routing and startup). Styles are in `assets/app.css`.

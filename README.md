# task

Task files for yena's projects, as a plugin (depends on `project`, whose docs folders in the md hub hold the tasks, and on `core`, whose kit draws the form). Tasks are filled by hand in a form or by commands, so the user and an assistant work with them the same way. Some tasks are routine and come back; before a new task the architect looks for similar past tasks and reuses their approaches and pitfalls. After the work the documentator records the outcome in the task file, which is what the next search finds.

Task files live in each project's docs in the md hub:

```
<YENA_DATA>/md/projects/<project>/tasks/<id>_<kebab-name>.md
e.g. /data/md/projects/web/tasks/TECH-12345_create-new-module.md
```

`<id>`: letters, digits and `-` (no `_`), up to 32 characters, unique in its project (case-insensitive). The task's name is free text (one line, up to 80 characters, spaces allowed) and is kept in the `name` property; `<kebab-name>` is its kebab-case form for the file name: its first latin words (up to 6 words, 50 characters), else those of the description, else `task`. `list`, `show` and `search` print the `name` property (a file without one falls back to its file name).

## File

A task file is Markdown with properties at the top, as Obsidian writes them; the description is the Markdown after them:

```
---
name: Fix login bug
project: web
created: 2026-10-27
status: todo
Priority: high
---

The login page fails after logout.
```

- `project` and `created` are written by `task new` and cannot be changed; `name` goes with the file name and cannot be changed either.
- `status`: one of the project's statuses (below). An `archived` task is left out of `task list` (shown with `--all`); `task search` still finds it.
- `type` and `parent` (optional) make epics: a task with `type: epic` groups the tasks whose `parent` is its id. One level only: an epic has no parent, and a parent is always an epic of the same project, named by its bare id (`parent: E-1`, written in the case of its file name). Only `type: epic` is ever written; a task has no `type` line (a hand-written `type: task` reads the same; other values are flagged by `show`). The list of an epic's tasks is computed from the `parent` lines and never stored.
- The description (required) is the body: one line when set by `task new`, `task set` or the form, any Markdown when the file is edited (sections such as `## Plan` or `### Conclusion` are added there by the agents when they have something to write; nothing is pre-filled).
- Extra properties, added by the user or a model: a key that starts with a letter and holds letters, digits and `-` (up to 32, e.g. `Priority`, `Due-date`), not a built-in one (`project`, `created`, `status`, `type`, `parent`, `description`, `id`, `name`), once per task (case-insensitive); the value is one line.
- Keys are matched case-insensitively, so older files with `Status:` keep working. Values YAML would read otherwise (`a: b`, `#tag`, `yes`, …) are written in double quotes. Properties written elsewhere that the module does not edit (lists such as `tags:` with `- a` lines, keys with spaces) are shown by `show` (lists joined with `, `) and left untouched by the form; `task set` on such a key replaces it with one line.

## Statuses

Each project has its own list of statuses, kept in `tasks/statuses.md` of its docs (the name has no `_`, so it is never taken for a task); a project without the file uses the default `todo`, `in-progress`, `done`. `archived` is allowed in every project, listed or not. A status is one kebab-case word up to 32 characters; a list holds at most 20, without repeats, and at least one besides `archived`.

```
# Task statuses of web

One per list item, in order; a new task gets the first. archived is always allowed.

- todo
- in-progress
- review
- done
```

`task set-statuses` writes the file; it may also be edited by hand: every list item (`- `, `* ` or `+ `) is a status, headings and other lines are notes. A broken file (an item that is not a status, no items) is an error that names the file, never a silent fall back to the default.

The list is enforced for the user and the assistant alike: `task new --status`, `task set … status`, `task status` and the form refuse any other status and name the allowed ones. A new task without `--status` gets the first status of the list that is not `archived`. A task whose status is not (or no longer) in the list keeps it: `task status` and `task show` flag it, the form saves it unchanged, `task set-statuses` lists such tasks after changing the list; `task search --status` takes any status, so old ones are still found.

## Commands

Writing works only in a project isolated with `project isolate` (the project module says which are); reading works everywhere. Ids and field names are matched case-insensitively. A file is changed by writing next to it and renaming over it (never through a symlink; files over 256 KiB are refused).

- `task list [<project>] [--all]` lists tasks of every project or of one: label, status (`-` when there is none), the first line of the description (the name for a task without one) and path. Tasks with status `archived` are shown only with `--all`; otherwise the list ends with `N archived hidden (task list [<project>] --all)` (`No open tasks in <dir>; …` when nothing else is left). An epic's text starts with `[epic] ` and its shown tasks follow it, indented by two spaces. A task whose parent is missing or not an epic stays at the top level with `(parent <id> missing)` or `(parent <label> is not an epic)` before the path; a shown task of a hidden (archived) epic gets `(epic <label> is archived)`; a hidden archived task counts in the hidden total.
- `task new [<project>] [--id <id>] [--name <name>] [--status <status>] [--type task|epic] [--parent <epic-id>] [<description…>]`:
  - with a description (the rest of the line; `--` ends the options) it creates the task and prints its path. No `--id`: the next `TASK-<n>` of that project. `--name` takes one word, or a name with spaces in double quotes (`--name "Fix login bug"`, since the console splits lines on whitespace); no `--name`: the first latin words of the description (up to 6 words, 50 characters), or `task`. An existing file is never overwritten. `--type epic` makes an epic; `--parent <epic-id>` puts the task under an epic of the same project (refused for an epic, a missing task or one that is not an epic).
  - without one, in the app, it opens the form (below); with no project it takes the isolated one, or asks which when several are isolated. The options fill the form. From a terminal or an assistant run a description is required.
- `task edit <project> <id>` opens the form for an existing task (in the app only; assistants use `set`/`unset`).
- `task show <project> <id>` prints the label and name, the path, every property, `Missing: …` when the status or the description is absent, then the description. For an epic it adds `Tasks (N):` with one line per task (label, status, name) and `By status: todo 2, done 1` (in the project's order), or `Tasks: none (…)`; for a task with a parent, `Parent: <label>  <name>`, or `Parent <id> is missing` / `Parent <label> is not an epic` with how to fix it. Hand edits are flagged: an epic with a parent, a type other than task or epic, a task that others name as parent but is not an epic.
- `task set <project> <id> <field> <value…>` sets `status`, an extra property (added when missing) or `description` (replaces the whole body with one line); prints `web/TASK-1: Priority = high`, with `(added)` or `(unchanged)`. `type epic|task` adds or removes the `type: epic` line (an epic with tasks cannot become a task, a task with a parent cannot become an epic); `parent <epic-id>` puts a task under an epic of the same project (refused for an epic).
- `task unset <project> <id> <field>` removes an extra property, the parent or the type (refused for an epic with tasks); status and description are refused.
- `task status <project> <id> [<status>]` prints the status (`web/TASK-2: in-progress`, with `(not a status of web (…))` when the list lacks it) or sets it to one of the project's statuses (`todo -> in-progress`). A task without a status gets one as the last property (a file without properties gets them at the top).
- `task statuses <project>` prints the project's statuses, `archived` last, and where they come from (its `statuses.md`, or the default).
- `task set-statuses <project> <status…>` sets the project's own list, in order (isolated projects only); prints the list before and after and the tasks whose status is outside the new one.
- `task delete <project> <id>` (alias `rm`) deletes the task file; an epic with tasks is refused (the message names them) until their parent is unset.
- `task search [--project <p>] [--status <s>] [--limit <n>] <id | words | "phrase">…` finds tasks in every project, archived ones too, and prints the best `--limit` (default 10, at most 50): label, name, `[status]`, score, path, the first line under a `Conclusion` heading (else the first text line of the description), then up to two other body lines with the most matches as `L<n>: …` (the file line number, for a read at that line). It serves both a lookup (an id, a name, a phrase) and the search for similar past tasks before planning.
  - Ids: a token with a `-` and a digit (`TECH-12`), a label (`web/TECH-12`) or a bare number (`12`). An exact id or label scores 100, so it comes first; a number matches the number at the end of an id (30) and also counts as a word of the text. An id or label that names no task adds nothing (no fallback to its words). Tokens such as `oauth2` are words.
  - Words: in the id and name weigh 3, in headings 2, in the whole file 1 (each counted up to 3 times); forms of a word match by prefix (4+ letters) at ½, typos at ⅓ (edit distance 1 from 5 letters, 2 when both words have 8+; swapped neighbours count as one).
  - `"quoted phrases"` (case and runs of spaces ignored) must appear in the name or text, else the task is left out; one in the name adds 6, in the text 3. A query of plain words found as a whole adds 4 in the name, 2 in the text.
  - The score is scaled by the share of query parts found; tasks of `--project` get ×1.5; hits under a fifth of the best score are dropped. `--status` searches only tasks with that status. `--` ends the options.
- `task` or `task help` shows the help generated by core; the prose that used to be in the usage (search syntax, statuses, ids) is in the notes of each subcommand (`help task search`).

Assistant policies: `edit` is `deny` (a form is for the user), `delete` and `set-statuses` (the list is the user's rule for the assistant) are `confirm`, the rest `safe`. An assistant reaches all of them through the console MCP tools, so it can do everything the user does except fill the form.

## Form

`task new` and `task edit` show core's kit `Form` in the console panel: Project and, for a new task, ID (the next `TASK-<n>` filled in) and Name (empty: from the description); then Status, Type (`task` or `epic`), Parent (the id of an epic in the project; empty: none), Description, the extra fields and `+ Add field`, over three buttons:

- **Cancel** (or Esc): closes the form, nothing is written.
- **Save**: checks the fields and writes the task; a problem (e.g. an empty description or a taken id) is shown and the form stays. Emptying an extra field removes it. A description of several lines is shown read-only (`<first line> (N lines: edit the file)`) and kept as it is.
- **Save and discuss**: saves, then runs `claude send Let's discuss task <project>/<id> (<path>). …` in the console, which puts the message into the open chat (or starts one). Without the claude module it prints the message to send instead.

↑/↓ or Tab move between rows, typing edits the field, Enter goes to the next row or presses the chosen button, ←/→ choose a button.

## Layout

`src/`: `index.ts` (plugin; the docs root and the isolation check come from the project module), `deps/project.ts` (project's `docsRootFor`, `isolatedProjects`, `isProjectName`), `ui/kit.ts` (core's kit `Form`, `ListPicker`), `commands.ts`, `tasks.ts` (names, listing, numbering, built-in properties, task type and parent, project statuses and their file, template, exclusive create, bounded reads), `frontmatter.ts` (reads and edits the properties and the body, pure), `ui/task-form.tsx` (the form and the project picker, loaded only when shown), `search.ts` (ranking). Tests: `npm test`.

## Residual risks

- Search matches words, not meaning: a similar task described with other words is missed. Typo tolerance can match an unrelated word one letter away (`cache` / `catch`), at a third of the weight.
- Only the first 256 KiB of a file and at most 5000 files are searched. Symlinked files and folders are skipped.
- The isolation check is a courtesy for the command; the hard rule for the assistant's own edits is in the claude module.
- Console lines are split on whitespace, so a value set by command loses runs of spaces; values are one line.
- Only the YAML the module writes is parsed: block scalars (`key: |`) and nested maps are kept as they are, but `show` prints only their first line (`|`).

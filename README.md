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
status: new
Priority: high
---

The login page fails after logout.
```

- `project` and `created` are written by `task new` and cannot be changed; `name` goes with the file name and cannot be changed either.
- `status`: one kebab-case word up to 32 characters: `new` (the default), `in-progress`, `review`, `done`, `blocked`, `cancelled`, or any other.
- The description (required) is the body: one line when set by `task new`, `task set` or the form, any Markdown when the file is edited (sections such as `## Plan` or `### Conclusion` are added there by the agents when they have something to write; nothing is pre-filled).
- Extra properties, added by the user or a model: a key that starts with a letter and holds letters, digits and `-` (up to 32, e.g. `Priority`, `Due-date`), not a built-in one (`project`, `created`, `status`, `description`, `id`, `name`), once per task (case-insensitive); the value is one line.
- Keys are matched case-insensitively, so older files with `Status:` keep working. Values YAML would read otherwise (`a: b`, `#tag`, `yes`, …) are written in double quotes. Properties written elsewhere that the module does not edit (lists such as `tags:` with `- a` lines, keys with spaces) are shown by `show` (lists joined with `, `) and left untouched by the form; `task set` on such a key replaces it with one line.

## Commands

Writing works only in a project isolated with `project isolate` (the project module says which are); reading works everywhere. Ids and field names are matched case-insensitively. A file is changed by writing next to it and renaming over it (never through a symlink; files over 256 KiB are refused).

- `task list [<project>]` lists tasks of every project or of one: label, status (`-` when there is none), the first line of the description (the name for a task without one) and path.
- `task new [<project>] [--id <id>] [--name <name>] [--status <status>] [<description…>]`:
  - with a description (the rest of the line; `--` ends the options) it creates the task and prints its path. No `--id`: the next `TASK-<n>` of that project. `--name` takes one word, or a name with spaces in double quotes (`--name "Fix login bug"`, since the console splits lines on whitespace); no `--name`: the first latin words of the description (up to 6 words, 50 characters), or `task`. An existing file is never overwritten.
  - without one, in the app, it opens the form (below); with no project it takes the isolated one, or asks which when several are isolated. The options fill the form. From a terminal or an assistant run a description is required.
- `task edit <project> <id>` opens the form for an existing task (in the app only; assistants use `set`/`unset`).
- `task show <project> <id>` prints the label and name, the path, every property, `Missing: …` when the status or the description is absent, then the description.
- `task set <project> <id> <field> <value…>` sets `status`, an extra property (added when missing) or `description` (replaces the whole body with one line); prints `web/TASK-1: Priority = high`, with `(added)` or `(unchanged)`.
- `task unset <project> <id> <field>` removes an extra property; status and description are refused.
- `task status <project> <id> [<status>]` prints the status (`web/TASK-2: in-progress`) or sets it (`new -> in-progress`). A task without a status gets one as the last property (a file without properties gets them at the top).
- `task delete <project> <id>` (alias `rm`) deletes the task file.
- `task search [--project <project>] <words>…` searches the tasks of every project and prints the best 10: label, title, score, path and the first line under a `Conclusion` heading (else the first text line of the description). Words in the number and name weigh 3, in headings 2, in the body 1 (each counted up to 3 times); forms of a word match by prefix (4+ letters) at half weight; the score is scaled by the share of query words found, and tasks of `--project` get ×1.5.
- `task` or `task help` prints the usage.

Assistant policies: `edit` is `deny` (a form is for the user), `delete` is `confirm`, the rest `safe`. An assistant reaches all of them through the console MCP tools, so it can do everything the user does except fill the form.

## Form

`task new` and `task edit` show core's kit `Form` in the console panel: Project and, for a new task, ID (the next `TASK-<n>` filled in) and Name (empty: from the description); then Status, Description, the extra fields and `+ Add field`, over three buttons:

- **Cancel** (or Esc): closes the form, nothing is written.
- **Save**: checks the fields and writes the task; a problem (e.g. an empty description or a taken id) is shown and the form stays. Emptying an extra field removes it. A description of several lines is shown read-only (`<first line> (N lines: edit the file)`) and kept as it is.
- **Save and discuss**: saves, then runs `claude send Let's discuss task <project>/<id> (<path>). …` in the console, which puts the message into the open chat (or starts one). Without the claude module it prints the message to send instead.

↑/↓ or Tab move between rows, typing edits the field, Enter goes to the next row or presses the chosen button, ←/→ choose a button.

## Layout

`src/`: `index.ts` (plugin; the docs root and the isolation check come from the project module), `deps/project.ts` (project's `docsRootFor`, `isolatedProjects`, `isProjectName`), `ui/kit.ts` (core's kit `Form`, `ListPicker`), `commands.ts`, `tasks.ts` (names, listing, numbering, built-in properties, template, exclusive create, bounded reads), `frontmatter.ts` (reads and edits the properties and the body, pure), `ui/task-form.tsx` (the form and the project picker, loaded only when shown), `search.ts` (ranking). Tests: `npm test`.

## Residual risks

- Search matches words, not meaning: a similar task described with other words is missed.
- Only the first 256 KiB of a file and at most 5000 files are searched. Symlinked files and folders are skipped.
- The isolation check is a courtesy for the command; the hard rule for the assistant's own edits is in the claude module.
- Console lines are split on whitespace, so a value set by command loses runs of spaces; values are one line.
- Only the YAML the module writes is parsed: block scalars (`key: |`) and nested maps are kept as they are, but `show` prints only their first line (`|`).

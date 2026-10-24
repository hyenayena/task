# task

Task files for yena's projects, as a plugin (depends on `project` only; the docs folders in the md hub belong to project, which tells where they are). Some tasks are routine and come back; before a new task the architect looks for similar past tasks and reuses their approaches and pitfalls. After the work the documentator records the outcome in the task file, which is what the next search finds.

Task files live in each project's docs in the md hub:

```
<YENA_DATA>/md/projects/<project>/tasks/<number>_<kebab-name>.md
e.g. /data/md/projects/web/tasks/TECH-12345_create-new-module.md
```

`<number>`: letters, digits and `-` (no `_`). `<kebab-name>`: lowercase letters and digits joined by `-`, up to 80 characters.

## Commands

All are `safe` for assistants (writing is limited to isolated projects).

- `task list [<project>]` lists task files of every project or of one.
- `task new <project> <name> [<number>]` creates a task file from the template and prints its path. Without a number it takes the next `TASK-<n>` of that project (highest `TASK-<n>` + 1). The number must not be used in that project yet (case-insensitive); an existing file is never overwritten. Only in a project isolated with `project isolate` (read from `<YENA_DATA>/project/state.json`; anything unreadable counts as not isolated).
- `task status <project> <id> [<status>]` prints the task's status (`web/TASK-2: in-progress`), or sets it. A status is one kebab-case word up to 32 characters: `new` (what `task new` writes), `in-progress`, `review`, `done`, `blocked`, `cancelled`, or any other. Reading works for every project; setting only in an isolated project. The id is matched case-insensitively. The file is written next to itself and renamed over (never through a symlink; files over 256 KiB are refused); a task without a status line (made before the status existed) gets one after `Created:`. `task list` shows the status of each task (`-` when there is none).
- `task search [--project <project>] <words>…` searches the tasks of every project and prints the best 10: label, title, score, path and the first line of the Conclusion (or of the Request). Words in the number and name weigh 3, in headings 2, in the body 1 (each counted up to 3 times); forms of a word match by prefix (4+ letters) at half weight; the score is scaled by the share of query words found, and tasks of `--project` get ×1.5.
- `task` or `task help` prints the usage.

## Template

```
# <number> <Title>

Project: <project>
Created: <YYYY-MM-DD>
Status: new

## Request
## Similar tasks
## Plan
## Outcome
### Conclusion
### Specifics
### Asked by the user
### Changes and why
```

Request, Similar tasks and Plan are written by the architect, who sets the task `in-progress` once planned; the Outcome sections by the documentator, who sets `done` (or `blocked`) (see `agents/architect.md`, `agents/documentator.md` and `commands/pipeline.md` in the md hub).

## Layout

`src/`: `index.ts` (plugin; the docs root and the isolation check come from the project module), `deps/project.ts` (the only import of another module: project's `docsRootFor`, `isolatedProjects`, `isProjectName`), `commands.ts`, `tasks.ts` (names, listing, numbering, template, exclusive create, bounded reads), `search.ts` (ranking). Tests: `npm test`.

## Residual risks

- Search matches words, not meaning: a similar task described with other words is missed.
- Only the first 256 KiB of a file and at most 5000 files are searched. Symlinked files and folders are skipped.
- The isolation check is a courtesy for the command; the hard rule for the assistant's own edits is in the claude module.

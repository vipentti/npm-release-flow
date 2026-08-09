<!-- BEGIN PLANLET AGENTS v:1 hash:033327ff -->
## Planning with Planlet

This repository uses Planlet for focused implementation plans. A planlet is
`plans/<slug>/plan.md` + `tasks.md`; Markdown is the source of truth.

- Propose a planlet before multi-step work; skip it for one-file changes.
- Use the `planlet` CLI for lifecycle state, including task checkboxes and
  completion/archive. Edit plan and task body content directly.
  Commands: `planlet create|show|tasks|status|validate <slug>`,
  `planlet task check <slug> <task-id>`, `planlet complete <slug>`.
- Check each task off only after its verification passes. When the last task is
  checked, run `planlet complete <slug>` to archive it.
- Run `planlet help [command]` before using a command you have not used here.
- If no `planlet` executable is available, stop and say so. Do not hand-create
  planlet files.
<!-- END PLANLET AGENTS -->

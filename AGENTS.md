<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Working in branches

Before making any change, check the current branch (`git branch --show-current`).
If it's `main` (or any non-feature branch), say so and ask whether to create a
branch first — don't start editing until the user answers. Feature work goes on
its own branch (e.g. `feat/<topic>`, `fix/<topic>`) and reaches `main` only when
the user asks to merge it.
